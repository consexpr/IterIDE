// Protocol: runner result.json timeLimitMs memoryLimitMiB executable
// Passthrough: runner --exec -- command [args...]
// stdin/stdout/stderr are inherited, while accounting goes only to result.json.
#include <chrono>
#include <fstream>
#include <string>
#include <cstdlib>
#include <algorithm>
#include <filesystem>
#include <vector>
#include <cstdio>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <shellapi.h>
// Windows 10's job-list attribute is absent from some MinGW header versions.
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST 0x0002000D
#endif
#else
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#ifdef __APPLE__
#include <libproc.h>
#endif
#endif

using Clock = std::chrono::steady_clock;
#ifdef _WIN32
static std::wstring wide(const char *text);
#endif
static double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
static void report(const std::string &file, double cpu, double wall, unsigned long long memory, unsigned long long code,
                   int signal, const char *status, bool wallTimedOut) {
#ifdef _WIN32
    std::ofstream out(std::filesystem::path(wide(file.c_str())));
#else
    std::ofstream out(file);
#endif
    out << "{\"timeMs\":" << cpu << ",\"wallMs\":" << wall << ",\"memoryKb\":" << memory << ",\"exitCode\":" << code
        << ",\"signal\":" << signal << ",\"status\":\"" << status
        << "\",\"wallTimedOut\":" << (wallTimedOut ? "true" : "false") << "}\n";
}
#ifdef _WIN32
static std::wstring wide(const char *text) {
    int n = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
    std::wstring value(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text, -1, &value[0], n);
    value.resize(n - 1);
    return value;
}
static unsigned long long ticks(FILETIME t) {
    return (static_cast<unsigned long long>(t.dwHighDateTime) << 32) | t.dwLowDateTime;
}
static std::string utf8(const wchar_t *text) {
    int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    std::string value(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, value.data(), n, nullptr, nullptr);
    value.resize(n - 1);
    return value;
}
// Windows CRT quoting: preserve empty arguments, embedded quotes and trailing '\'.
static std::wstring quote(const std::wstring &arg) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') {
            ++slashes;
            continue;
        }
        result.append(slashes * (c == L'"' ? 2 : 1) + (c == L'"' ? 1 : 0), L'\\');
        slashes = 0;
        result += c;
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
}
static bool startChild(HANDLE job, int argc, char **argv, PROCESS_INFORMATION &process) {
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<unsigned char> attributes(size);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &size))
        return false;
    // Join atomically at creation. AssignProcessToJobObject afterwards leaves a
    // suspended orphan (and open pipes) if the runner is killed between the calls.
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job),
                                   nullptr, nullptr)) {
        DWORD error = GetLastError();
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        SetLastError(error);
        return false;
    }
    std::wstring command;
    for (int i = 0; i < argc; ++i) {
        if (i)
            command += L' ';
        command += quote(wide(argv[i]));
    }
    // A null application name also supports commands resolved through PATH.
    BOOL created = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                  CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
                                  &startup.StartupInfo, &process);
    DWORD error = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    if (!created) {
        SetLastError(error);
        return false;
    }
    if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
        DWORD error = GetLastError();
        TerminateProcess(process.hProcess, 125);
        WaitForSingleObject(process.hProcess, INFINITE);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        SetLastError(error);
        return false;
    }
    CloseHandle(process.hThread);
    return true;
}
static int passthrough(int argc, char **argv) {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        std::fprintf(stderr, "runner: CreateJobObject failed (%lu)\n", GetLastError());
        return 125;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        std::fprintf(stderr, "runner: job setup failed (%lu)\n", GetLastError());
        CloseHandle(job);
        return 125;
    }
    PROCESS_INFORMATION process{};
    if (!startChild(job, argc, argv, process)) {
        std::fprintf(stderr, "runner: cannot start child (%lu)\n", GetLastError());
        CloseHandle(job);
        return 125;
    }
    DWORD code = 125;
    if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0)
        GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    // The job handle is not inherited. Normal exit and forced runner termination
    // both close its last handle, terminating any remaining descendants.
    CloseHandle(job);
    return static_cast<int>(code);
}
#else
static volatile sig_atomic_t childPid = 0;
static void terminate(int) {
    if (childPid > 0) {
        kill(-childPid, SIGKILL);
        kill(childPid, SIGKILL);
    }
}
#endif

int main(int argc, char **argv) {
#ifdef _WIN32
    SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    // MinGW's narrow argv uses the system code page. Decode the original UTF-16
    // command line so paths/arguments reach both protocols without data loss.
    int count = 0;
    wchar_t **parsed = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!parsed)
        return 125;
    std::vector<std::string> strings;
    for (int i = 0; i < count; ++i)
        strings.push_back(utf8(parsed[i]));
    LocalFree(parsed);
    std::vector<char *> arguments;
    for (auto &value : strings)
        arguments.push_back(value.data());
    arguments.push_back(nullptr);
    argc = count;
    argv = arguments.data();
#endif
    if (argc >= 2 && std::string(argv[1]) == "--exec") {
        if (argc < 4 || std::string(argv[2]) != "--")
            return 125;
#ifdef _WIN32
        return passthrough(argc - 3, argv + 3);
#else
        execvp(argv[3], argv + 3);
        return 125;
#endif
    }
    if (argc != 5)
        return 125;
    const double limit = std::max(1.0, std::atof(argv[2]));
    const unsigned long long bytes = static_cast<unsigned long long>(std::atof(argv[3]) * 1024 * 1024);
    const double deadline = limit + std::max(100.0, limit * 0.15);
    const auto start = Clock::now();
    bool tle = false, mle = false, wallTimedOut = false;
#ifdef _WIN32
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    HANDLE port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1);
    if (!job || !port)
        return 125;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                                              JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    limits.ProcessMemoryLimit = static_cast<SIZE_T>(bytes);
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{};
    association.CompletionKey = job;
    association.CompletionPort = port;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
        !SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)))
        return 125;
    PROCESS_INFORMATION process{};
    if (!startChild(job, 1, argv + 4, process)) {
        CloseHandle(job);
        CloseHandle(port);
        return 125;
    }
    auto messages = [&]() {
        DWORD message = 0;
        ULONG_PTR key = 0;
        LPOVERLAPPED overlapped = nullptr;
        while (GetQueuedCompletionStatus(port, &message, &key, &overlapped, 0)) {
            if (message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT || message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT)
                mle = true;
        }
    };
    FILETIME created{}, exited{}, kernel{}, user{};
    while (WaitForSingleObject(process.hProcess, 5) == WAIT_TIMEOUT) {
        messages();
        GetProcessTimes(process.hProcess, &created, &exited, &kernel, &user);
        if ((ticks(kernel) + ticks(user)) / 10000.0 > limit)
            tle = true;
        else if (elapsed(start) > deadline) {
            tle = true;
            wallTimedOut = true;
        }
        if (tle || mle) {
            TerminateJobObject(job, 1);
            break;
        }
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    messages();
    GetProcessTimes(process.hProcess, &created, &exited, &kernel, &user);
    double cpu = (ticks(kernel) + ticks(user)) / 10000.0;
    PROCESS_MEMORY_COUNTERS counters{};
    counters.cb = sizeof(counters);
    GetProcessMemoryInfo(process.hProcess, &counters, sizeof(counters));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION measured{};
    QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &measured, sizeof(measured), nullptr);
    unsigned long long peak =
        std::max(static_cast<SIZE_T>(counters.PeakWorkingSetSize), measured.PeakProcessMemoryUsed) / 1024;
    DWORD code = 0;
    GetExitCodeProcess(process.hProcess, &code);
    report(argv[1], cpu, elapsed(start), peak, code, 0,
           mle ? "memory_limit" : (tle || cpu > limit ? "time_limit" : "ok"), wallTimedOut);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    CloseHandle(port);
#else
    signal(SIGTERM, terminate);
    signal(SIGINT, terminate);
    sigset_t blocked, previous;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGTERM);
    sigaddset(&blocked, SIGINT);
    sigprocmask(SIG_BLOCK, &blocked, &previous);
    pid_t pid = fork();
    if (pid < 0)
        return 125;
    if (pid == 0) {
        setpgid(0, 0);
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        sigprocmask(SIG_SETMASK, &previous, nullptr);
        struct rlimit memory{static_cast<rlim_t>(bytes), static_cast<rlim_t>(bytes)};
        struct rlimit cpu{static_cast<rlim_t>((limit + 999) / 1000 + 1), static_cast<rlim_t>((limit + 999) / 1000 + 1)};
        struct rlimit core{0, 0};
        setrlimit(RLIMIT_AS, &memory);
        setrlimit(RLIMIT_CPU, &cpu);
        setrlimit(RLIMIT_CORE, &core);
        execl(argv[4], argv[4], static_cast<char *>(nullptr));
        _exit(127);
    }
    childPid = pid;
    setpgid(pid, pid);
    sigprocmask(SIG_SETMASK, &previous, nullptr);
    int status = 0;
    struct rusage usage{};
    unsigned long long observedPeak = 0;
    while (true) {
        pid_t result = wait4(pid, &status, WNOHANG, &usage);
        if (result == pid)
            break;
        if (result < 0 && errno != EINTR)
            return 125;
#ifdef __APPLE__
        struct proc_taskinfo task{};
        if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, sizeof(task)) == sizeof(task)) {
            observedPeak = std::max(observedPeak, static_cast<unsigned long long>(task.pti_resident_size / 1024));
            if (task.pti_resident_size > bytes) {
                mle = true;
                kill(-pid, SIGKILL);
            }
        }
#endif
        if (elapsed(start) > deadline) {
            tle = true;
            wallTimedOut = true;
            kill(-pid, SIGKILL);
        }
        usleep(5000);
    }
    kill(-pid, SIGKILL); // Reap the program's remaining descendants too.
    childPid = 0;
    const double cpu = usage.ru_utime.tv_sec * 1000.0 + usage.ru_utime.tv_usec / 1000.0 +
                       usage.ru_stime.tv_sec * 1000.0 + usage.ru_stime.tv_usec / 1000.0;
    unsigned long long peak = usage.ru_maxrss;
#ifdef __APPLE__
    peak /= 1024; // macOS reports bytes; Linux reports KiB.
#endif
    int sig = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    peak = std::max(peak, observedPeak);
    mle = mle || peak >= bytes / 1024;
    tle = tle || cpu > limit || sig == SIGXCPU;
    report(argv[1], cpu, elapsed(start), peak, WIFEXITED(status) ? WEXITSTATUS(status) : 0, sig,
           mle ? "memory_limit" : (tle ? "time_limit" : "ok"), wallTimedOut);
#endif
    return 0;
}
