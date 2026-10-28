/** Pseudo-console bridge. It never invokes a command shell: paths stay wide-character argv
 * values, the program runs in a ConPTY owned by this helper, and a job object owns the
 * program and its descendants even when the window is closed.
 *
 * Usage: host <executable> <directory> <statusFile> <columns> <rows>
 * Both pipes carry frames: 1 type byte, 4 byte little-endian length, payload.
 *   stdin  : 'i' input bytes, 'r' columns:u16 rows:u16, 'k' kill the program
 *   stdout : 'o' output bytes, 'x' exit code:u32
 * Inside the pseudo console, `host --shim <executable>` selects UTF-8 and runs the program. */
export const terminalHostSource = String.raw`#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

typedef HRESULT (WINAPI *CreatePseudoConsoleFn)(COORD, HANDLE, HANDLE, DWORD, void**);
typedef HRESULT (WINAPI *ResizePseudoConsoleFn)(void*, COORD);
typedef void (WINAPI *ClosePseudoConsoleFn)(void*);
static const DWORD kPseudoConsoleAttribute = 0x00020016;

static HANDLE job = NULL, process = NULL, reader = NULL;
static HANDLE inputWrite = NULL, outputRead = NULL;
static void* pseudo = NULL;
static ResizePseudoConsoleFn resizePseudo = NULL;
static ClosePseudoConsoleFn closePseudo = NULL;
static CRITICAL_SECTION sendLock;

static bool writeAll(HANDLE handle, const void* data, DWORD length) {
  const char* bytes = static_cast<const char*>(data);
  while (length) {
    DWORD written = 0;
    if (!WriteFile(handle, bytes, length, &written, NULL) || !written) return false;
    bytes += written;
    length -= written;
  }
  return true;
}

static bool readExact(HANDLE handle, void* data, DWORD length) {
  char* bytes = static_cast<char*>(data);
  while (length) {
    DWORD got = 0;
    if (!ReadFile(handle, bytes, length, &got, NULL) || !got) return false;
    bytes += got;
    length -= got;
  }
  return true;
}

static void send(char type, const void* data, DWORD length) {
  unsigned char header[5] = { static_cast<unsigned char>(type), static_cast<unsigned char>(length),
    static_cast<unsigned char>(length >> 8), static_cast<unsigned char>(length >> 16),
    static_cast<unsigned char>(length >> 24) };
  EnterCriticalSection(&sendLock);
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (writeAll(out, header, 5) && length) writeAll(out, data, length);
  LeaveCriticalSection(&sendLock);
}

static void status(const wchar_t* file, const char* message, DWORD error = 0) {
  FILE* stream = _wfopen(file, L"wb");
  if (!stream) return;
  if (error) std::fprintf(stream, "error:%lu:%s", static_cast<unsigned long>(error), message);
  else std::fputs(message, stream);
  std::fclose(stream);
}

static int failure(const wchar_t* file, const char* message, DWORD error) {
  status(file, message, error ? error : ERROR_GEN_FAILURE);
  return 1;
}

// CommandLineToArgvW-compatible quoting, including trailing backslashes.
static std::wstring quote(const wchar_t* value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const wchar_t* p = value; *p; ++p) {
    if (*p == L'\\') { ++slashes; continue; }
    if (*p == L'"') result.append(slashes * 2 + 1, L'\\');
    else result.append(slashes, L'\\');
    result += *p;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  result += L'"';
  return result;
}

// Runs inside the pseudo console: the program sees UTF-8 and the console's real handles.
static int shim(const wchar_t* executable) {
  SetConsoleCP(CP_UTF8);
  SetConsoleOutputCP(CP_UTF8);
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  // Use the console's own handles, never anything inherited from the helper's pipes.
  SECURITY_ATTRIBUTES inheritable = { sizeof(inheritable), NULL, TRUE };
  HANDLE input = CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inheritable, OPEN_EXISTING, 0, NULL);
  HANDLE output = CreateFileW(L"CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inheritable, OPEN_EXISTING, 0, NULL);
  if (input == INVALID_HANDLE_VALUE || output == INVALID_HANDLE_VALUE) return 1;
  SetStdHandle(STD_INPUT_HANDLE, input);
  SetStdHandle(STD_OUTPUT_HANDLE, output);
  SetStdHandle(STD_ERROR_HANDLE, output);
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = input;
  startup.hStdOutput = startup.hStdError = output;
  PROCESS_INFORMATION child = {};
  std::wstring command = quote(executable);
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(0);
  if (!CreateProcessW(executable, mutableCommand.data(), NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) {
    std::fprintf(stderr, "ITER: cannot start program (Windows error %lu)\n", static_cast<unsigned long>(GetLastError()));
    return 1;
  }
  CloseHandle(child.hThread);
  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess);
  return static_cast<int>(code);
}

static DWORD WINAPI pump(LPVOID) {
  std::vector<char> buffer(16384);
  DWORD got = 0;
  while (ReadFile(outputRead, buffer.data(), static_cast<DWORD>(buffer.size()), &got, NULL) && got)
    send('o', buffer.data(), got);
  return 0;
}

static DWORD WINAPI waiter(LPVOID) {
  WaitForSingleObject(process, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process, &code);
  // Descendants must not keep running after their original program has exited.
  TerminateJobObject(job, code);
  // Closing the pseudo console flushes its last output, which pump keeps draining.
  closePseudo(pseudo);
  WaitForSingleObject(reader, 3000);
  unsigned char bytes[4] = { static_cast<unsigned char>(code), static_cast<unsigned char>(code >> 8),
    static_cast<unsigned char>(code >> 16), static_cast<unsigned char>(code >> 24) };
  send('x', bytes, 4);
  ExitProcess(0);
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && std::wcscmp(argv[1], L"--shim") == 0) return shim(argv[2]);
  if (argc != 6) return 2;
  const wchar_t* executable = argv[1];
  const wchar_t* directory = argv[2];
  const wchar_t* statusFile = argv[3];
  int columns = _wtoi(argv[4]), rows = _wtoi(argv[5]);
  if (columns < 2 || columns > 1000) columns = 120;
  if (rows < 2 || rows > 1000) rows = 30;
  InitializeCriticalSection(&sendLock);

  HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  CreatePseudoConsoleFn createPseudo = reinterpret_cast<CreatePseudoConsoleFn>(
    reinterpret_cast<void*>(GetProcAddress(kernel, "CreatePseudoConsole")));
  resizePseudo = reinterpret_cast<ResizePseudoConsoleFn>(
    reinterpret_cast<void*>(GetProcAddress(kernel, "ResizePseudoConsole")));
  closePseudo = reinterpret_cast<ClosePseudoConsoleFn>(
    reinterpret_cast<void*>(GetProcAddress(kernel, "ClosePseudoConsole")));
  if (!createPseudo || !resizePseudo || !closePseudo)
    return failure(statusFile, "This Windows version has no pseudo console (needs Windows 10 1809 or newer)", ERROR_CALL_NOT_IMPLEMENTED);

  HANDLE inputRead = NULL, outputWrite = NULL;
  if (!CreatePipe(&inputRead, &inputWrite, NULL, 0) || !CreatePipe(&outputRead, &outputWrite, NULL, 0))
    return failure(statusFile, "Cannot create terminal pipes", GetLastError());
  HRESULT created = createPseudo({ static_cast<SHORT>(columns), static_cast<SHORT>(rows) }, inputRead, outputWrite, 0, &pseudo);
  if (FAILED(created)) return failure(statusFile, "Cannot create pseudo console", static_cast<DWORD>(created));
  CloseHandle(inputRead);
  CloseHandle(outputWrite);

  job = CreateJobObjectW(NULL, NULL);
  if (!job) return failure(statusFile, "Cannot create program job", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return failure(statusFile, "Cannot configure program job", GetLastError());

  wchar_t self[32768];
  GetModuleFileNameW(NULL, self, 32768);
  std::wstring command = quote(self) + L" --shim " + quote(executable);
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(0);
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attributeSize);
  std::vector<char> attributeBytes(attributeSize);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBytes.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize) ||
      !UpdateProcThreadAttribute(attributes, 0, kPseudoConsoleAttribute, pseudo, sizeof(pseudo), NULL, NULL))
    return failure(statusFile, "Cannot attach pseudo console", GetLastError());
  STARTUPINFOEXW startup = {};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION child = {};
  if (!CreateProcessW(self, mutableCommand.data(), NULL, NULL, FALSE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, NULL, directory,
      &startup.StartupInfo, &child))
    return failure(statusFile, "Cannot start program", GetLastError());
  if (!AssignProcessToJobObject(job, child.hProcess)) {
    DWORD error = GetLastError();
    TerminateProcess(child.hProcess, 1);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    return failure(statusFile, "Cannot own program process", error);
  }
  process = child.hProcess;
  reader = CreateThread(NULL, 0, pump, NULL, 0, NULL);
  if (ResumeThread(child.hThread) == static_cast<DWORD>(-1)) {
    DWORD error = GetLastError();
    TerminateJobObject(job, 1);
    CloseHandle(child.hThread);
    return failure(statusFile, "Cannot resume program", error);
  }
  CloseHandle(child.hThread);
  HANDLE waiterThread = CreateThread(NULL, 0, waiter, NULL, 0, NULL);
  if (!reader || !waiterThread) {
    DWORD error = GetLastError();
    TerminateJobObject(job, 1);
    return failure(statusFile, "Cannot create console threads", error);
  }
  status(statusFile, "ready");

  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<char> payload;
  for (;;) {
    unsigned char header[5];
    if (!readExact(in, header, 5)) break;
    DWORD length = header[1] | header[2] << 8 | header[3] << 16 | static_cast<DWORD>(header[4]) << 24;
    if (length > (1u << 20)) break;
    payload.resize(length);
    if (length && !readExact(in, payload.data(), length)) break;
    if (header[0] == 'i') writeAll(inputWrite, payload.data(), length);
    else if (header[0] == 'r' && length == 4) {
      const unsigned char* b = reinterpret_cast<const unsigned char*>(payload.data());
      int c = b[0] | b[1] << 8, r = b[2] | b[3] << 8;
      if (c >= 2 && r >= 2) resizePseudo(pseudo, { static_cast<SHORT>(c), static_cast<SHORT>(r) });
    } else if (header[0] == 'k') TerminateJobObject(job, 130);
  }
  // The window or its owner went away: the program must not outlive it.
  TerminateJobObject(job, 130);
  // Let waiter close the pseudo console while pump drains it. Exiting this
  // thread immediately races that cleanup, especially with a full output pipe.
  WaitForSingleObject(waiterThread, 10000);
  ExitProcess(0);
  return 0;
}
`
