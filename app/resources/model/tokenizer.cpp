// Minimal libclang C API bridge. Uses the same single-file lexer as the trainer.
// Only byte ranges and CXTokenKind cross stdout; source text is never written.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct CXString {
    const void *data;
    unsigned flags;
};
struct CXLocation {
    const void *pointers[2];
    unsigned data;
};
struct CXRange {
    const void *pointers[2];
    unsigned begin, end;
};
struct CXToken {
    unsigned data[4];
    void *pointer;
};
struct CXUnsaved {
    const char *filename;
    const char *contents;
    unsigned long length;
};

template <class T> T symbol(HMODULE library, const char *name) {
    auto result = GetProcAddress(library, name);
    if (!result)
        throw std::runtime_error("Missing libclang C API");
    return reinterpret_cast<T>(result);
}
#define API(name, signature) auto name = symbol<signature>(library, #name)

static bool read_exact(void *data, size_t length) {
    return length == 0 || std::fread(data, 1, length, stdin) == length;
}
static void append(std::vector<uint8_t> &target, uint32_t value) {
    for (int i = 0; i < 4; ++i)
        target.push_back(static_cast<uint8_t>(value >> (i * 8)));
}
static uint32_t number(const uint8_t *value) {
    return uint32_t(value[0]) | uint32_t(value[1]) << 8 | uint32_t(value[2]) << 16 | uint32_t(value[3]) << 24;
}
static bool send(const std::vector<uint8_t> &payload) {
    uint32_t length = static_cast<uint32_t>(payload.size());
    return std::fwrite(&length, 1, 4, stdout) == 4 &&
           std::fwrite(payload.data(), 1, payload.size(), stdout) == payload.size() && std::fflush(stdout) == 0;
}
static void error(const char *message) {
    std::vector<uint8_t> payload{1};
    payload.insert(payload.end(), message, message + std::strlen(message));
    send(payload);
}
static std::string utf8(const wchar_t *value) {
    int length = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (length < 1)
        throw std::runtime_error("Invalid tokenizer path");
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), length, nullptr, nullptr);
    result.pop_back();
    return result;
}

int wmain(int argc, wchar_t **argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    if (argc != 4)
        return 2;
    const DWORD parent = static_cast<DWORD>(std::wcstoul(argv[3], nullptr, 10));
    std::thread([parent] {
        HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, parent);
        if (process) {
            WaitForSingleObject(process, INFINITE);
            CloseHandle(process);
        }
        ExitProcess(0);
    }).detach();
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.ProcessMemoryLimit = 512ull * 1024 * 1024;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(job, GetCurrentProcess())) {
        error("Cannot limit tokenizer resources");
        return 5;
    }
    HMODULE library =
        LoadLibraryExW(argv[1], nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!library) {
        error("Cannot load bundled libclang");
        return 3;
    }
    try {
        API(clang_getClangVersion, CXString(*)());
        API(clang_getCString, const char *(*)(CXString));
        API(clang_disposeString, void (*)(CXString));
        API(clang_createIndex, void *(*)(int, int));
        API(clang_disposeIndex, void (*)(void *));
        API(clang_parseTranslationUnit2,
            int (*)(void *, const char *, const char *const *, int, CXUnsaved *, unsigned, unsigned, void **));
        API(clang_disposeTranslationUnit, void (*)(void *));
        API(clang_getFile, void *(*)(void *, const char *));
        API(clang_getLocationForOffset, CXLocation(*)(void *, void *, unsigned));
        API(clang_getRange, CXRange(*)(CXLocation, CXLocation));
        API(clang_tokenize, void (*)(void *, CXRange, CXToken **, unsigned *));
        API(clang_disposeTokens, void (*)(void *, CXToken *, unsigned));
        API(clang_getTokenKind, int (*)(CXToken));
        API(clang_getTokenExtent, CXRange(*)(void *, CXToken));
        API(clang_getRangeStart, CXLocation(*)(CXRange));
        API(clang_getRangeEnd, CXLocation(*)(CXRange));
        API(clang_getSpellingLocation, void (*)(CXLocation, void **, unsigned *, unsigned *, unsigned *));
        const auto version = clang_getClangVersion();
        const char *versionText = clang_getCString(version);
        std::vector<uint8_t> hello{2};
        hello.insert(hello.end(), versionText, versionText + std::strlen(versionText));
        clang_disposeString(version);
        void *index = clang_createIndex(0, 0);
        if (!index)
            throw std::runtime_error("Cannot create Clang index");
        HANDLE empty = CreateFileW(argv[2], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                   nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
        if (empty == INVALID_HANDLE_VALUE)
            throw std::runtime_error("Cannot create tokenizer scratch buffer");
        CloseHandle(empty);
        const std::string filename = utf8(argv[2]);
        if (!send(hello))
            return 0;
        uint8_t header[4];
        while (read_exact(header, 4)) {
            uint32_t length = number(header);
            if (length < 4 || length > 256 * 1024 + 32)
                break;
            std::vector<uint8_t> request(length);
            if (!read_exact(request.data(), request.size()))
                break;
            uint32_t standardLength = number(request.data());
            if (standardLength > 16 || 4 + standardLength > length) {
                error("Invalid standard");
                continue;
            }
            std::string standard(reinterpret_cast<char *>(request.data() + 4), standardLength);
            const char *source = reinterpret_cast<char *>(request.data() + 4 + standardLength);
            unsigned sourceLength = length - 4 - standardLength;
            if (std::memchr(source, 0, sourceLength) ||
                standard.find_first_not_of("gnuc+0123456789") != std::string::npos) {
                error("Invalid lexical input");
                continue;
            }
            std::string standardArgument = "-std=" + standard;
            const char *arguments[] = {"-x", "c++", standardArgument.c_str(), "-fno-modules", "-fno-implicit-modules"};
            CXUnsaved unsaved{filename.c_str(), source, sourceLength};
            void *unit = nullptr;
            if (clang_parseTranslationUnit2(index, filename.c_str(), arguments, 5, &unsaved, 1, 0x600, &unit) ||
                !unit) {
                error("Clang lexical parse failed");
                continue;
            }
            CXToken *tokens = nullptr;
            unsigned count = 0;
            void *file = clang_getFile(unit, filename.c_str());
            if (file)
                clang_tokenize(unit,
                               clang_getRange(clang_getLocationForOffset(unit, file, 0),
                                              clang_getLocationForOffset(unit, file, sourceLength)),
                               &tokens, &count);
            std::vector<uint8_t> response{0};
            append(response, count);
            for (unsigned i = 0; i < count; ++i) {
                CXRange extent = clang_getTokenExtent(unit, tokens[i]);
                unsigned begin = 0, end = 0;
                clang_getSpellingLocation(clang_getRangeStart(extent), nullptr, nullptr, nullptr, &begin);
                clang_getSpellingLocation(clang_getRangeEnd(extent), nullptr, nullptr, nullptr, &end);
                response.push_back(static_cast<uint8_t>(clang_getTokenKind(tokens[i])));
                append(response, begin);
                append(response, end);
            }
            if (tokens)
                clang_disposeTokens(unit, tokens, count);
            clang_disposeTranslationUnit(unit);
            if (!file)
                error("Clang source buffer unavailable");
            else if (!send(response))
                break;
        }
        clang_disposeIndex(index);
    } catch (const std::exception &exception) {
        error(exception.what());
        return 4;
    }
    FreeLibrary(library);
    return 0;
}
