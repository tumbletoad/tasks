/*
 * Tasks Windows launcher, M0.03 packaging spike (A2 3.12.3). One source builds both launchers:
 *   ttasks.exe   console subsystem, Node in a kill-on-close job object. If Windows refuses any
 *               step of the job setup, Node never runs and the launcher exits 70
 *   ttasksw.exe  GUI subsystem (TTASKS_GUI defined), no console and no job object
 * TTASKS_TEST_HOOKS builds a test-only launcher that can simulate a refused job step. Release
 * builds never define it.
 *
 * In the spike:
 *   1. The mode comes from where the launcher sits. Version-local: the parent P of its folder sits
 *      in a folder named "versions" and P\manifest.json exists, so P is the version folder.
 *      Stable-dispatch: otherwise. P is the install root and <root>\current names the version.
 *   2. runtime\node.exe and lib\ttasks.mjs must exist under the version folder, or exit 70.
 *   3. TTASKS_ROOT, TTASKS_LAUNCHER, TTASKS_LAUNCH_MODE, TTASKS_PACKAGE and (with home.marker)
 *      TTASKS_HOME are set. NODE_OPTIONS and NODE_PATH are removed.
 *   4. The child command line is the quoted Node path, the fixed flags, the quoted entry path and
 *      this launcher's own command-line tail, copied verbatim from GetCommandLineW. Nothing is
 *      re-quoted and no cmd.exe is involved.
 *   5. --package-info and --replace <new> <target> are answered by the launcher itself.
 * Not in the spike: the ttasksw.exe supervisor loop, --port-owner and sibling repair (M1, M6).
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <appmodel.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define EXIT_USAGE 64
#define EXIT_SOFTWARE 70
#define PATH_CAP 32768
#define CMDLINE_CAP 32767

#ifndef FILE_RENAME_FLAG_REPLACE_IF_EXISTS
#define FILE_RENAME_FLAG_REPLACE_IF_EXISTS 0x00000001
#endif
#ifndef FILE_RENAME_FLAG_POSIX_SEMANTICS
#define FILE_RENAME_FLAG_POSIX_SEMANTICS 0x00000002
#endif
/*
 * FileRenameInfoEx is 22 in FILE_INFO_BY_HANDLE_CLASS (Windows 10 1607 and later). Its buffer is
 * FILE_RENAME_INFO with Flags in place of ReplaceIfExists. Declared here so the source does not
 * depend on the SDK's target-version macros.
 */
#define TTASKS_FILE_RENAME_INFO_EX ((FILE_INFO_BY_HANDLE_CLASS)22)
typedef struct {
    DWORD Flags;
    HANDLE RootDirectory;
    DWORD FileNameLength;
    WCHAR FileName[1];
} TTASKS_RENAME_INFO;

/* Writes UTF-8 text to a standard handle, if the launcher has one. */
static void write_to(DWORD which, const wchar_t *fmt, va_list ap) {
    wchar_t text[4096];
    char utf8[16384];
    HANDLE h = GetStdHandle(which);
    DWORD written = 0;
    int n;
    if (h == NULL || h == INVALID_HANDLE_VALUE) return;
    _vsnwprintf_s(text, _countof(text), _TRUNCATE, fmt, ap);
    n = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, (int)sizeof utf8, NULL, NULL);
    if (n > 1) WriteFile(h, utf8, (DWORD)(n - 1), &written, NULL);
}

static void say(const wchar_t *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    write_to(STD_ERROR_HANDLE, fmt, ap);
    va_end(ap);
}

static void out(const wchar_t *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    write_to(STD_OUTPUT_HANDLE, fmt, ap);
    va_end(ap);
}

static wchar_t *new_path(void) {
    wchar_t *p = (wchar_t *)calloc(PATH_CAP, sizeof(wchar_t));
    if (p == NULL) {
        say(L"ttasks: out of memory\n");
        ExitProcess(EXIT_SOFTWARE);
    }
    return p;
}

/* Joins two path parts. _TRUNCATE makes an overflow return -1 instead of aborting the process. */
static wchar_t *join(const wchar_t *dir, const wchar_t *name) {
    wchar_t *p = new_path();
    if (_snwprintf_s(p, PATH_CAP, _TRUNCATE, L"%s\\%s", dir, name) < 0) {
        say(L"ttasks: path too long\n");
        ExitProcess(EXIT_SOFTWARE);
    }
    return p;
}

/* Cuts the last component off a path in place and returns it, or NULL at a root. */
static const wchar_t *cut_last(wchar_t *path) {
    wchar_t *slash = wcsrchr(path, L'\\');
    if (slash == NULL) return NULL;
    *slash = L'\0';
    return slash + 1;
}

static int is_file(const wchar_t *path) {
    DWORD a = GetFileAttributesW(path);
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

/*
 * Reads <root>\current: 1 to 64 characters from [0-9A-Za-z.+-], not only dots, nothing else.
 * Rejecting "." and ".." keeps the version folder inside <root>\versions.
 */
static int read_current(const wchar_t *root, wchar_t *version) {
    wchar_t *path = join(root, L"current");
    char buf[66];
    DWORD n = 0, i;
    int only_dots = 1;
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        say(L"ttasks: cannot read %s (error %lu)\n", path, GetLastError());
        free(path);
        return 0;
    }
    if (!ReadFile(h, buf, 65, &n, NULL)) n = 0;
    CloseHandle(h);
    if (n < 1 || n > 64) {
        say(L"ttasks: %s does not hold a valid version\n", path);
        free(path);
        return 0;
    }
    for (i = 0; i < n; i++) {
        char c = buf[i];
        int ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                 c == '.' || c == '+' || c == '-';
        if (!ok) {
            say(L"ttasks: %s does not hold a valid version\n", path);
            free(path);
            return 0;
        }
        if (c != '.') only_dots = 0;
        version[i] = (wchar_t)c;
    }
    version[n] = L'\0';
    free(path);
    if (only_dots) {
        say(L"ttasks: current does not hold a valid version\n");
        return 0;
    }
    return 1;
}

/*
 * The command-line tail after argv[0], by the rules of the Microsoft C runtime that both this
 * launcher and node.exe use: in argv[0] a double quote toggles quoting and nothing escapes it,
 * and argv[0] ends at the first space or tab outside quotes. Whitespace after it is skipped.
 */
static const wchar_t *command_tail(const wchar_t *cmd) {
    const wchar_t *p = cmd;
    int quoted = 0;
    while (*p != L'\0') {
        if (*p == L'"') {
            quoted = !quoted;
        } else if (!quoted && (*p == L' ' || *p == L'\t')) {
            break;
        }
        p++;
    }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

static int package_info(void) {
    UINT32 length = 0;
    wchar_t *name;
    LONG rc = GetCurrentPackageFullName(&length, NULL);
    if (rc == APPMODEL_ERROR_NO_PACKAGE) {
        out(L"none\n");
        return 0;
    }
    if (rc != ERROR_INSUFFICIENT_BUFFER) {
        say(L"ttasks: GetCurrentPackageFullName failed (%ld)\n", rc);
        return EXIT_SOFTWARE;
    }
    name = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
    if (name == NULL || GetCurrentPackageFullName(&length, name) != ERROR_SUCCESS) {
        say(L"ttasks: GetCurrentPackageFullName failed\n");
        return EXIT_SOFTWARE;
    }
    out(L"%s\n", name);
    free(name);
    return 0;
}

/* Sets TTASKS_PACKAGE to the package full name, or removes it outside a package. */
static void set_package_variable(void) {
    UINT32 length = 0;
    wchar_t *name;
    if (GetCurrentPackageFullName(&length, NULL) != ERROR_INSUFFICIENT_BUFFER) {
        SetEnvironmentVariableW(L"TTASKS_PACKAGE", NULL);
        return;
    }
    name = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
    if (name != NULL && GetCurrentPackageFullName(&length, name) == ERROR_SUCCESS) {
        SetEnvironmentVariableW(L"TTASKS_PACKAGE", name);
    } else {
        SetEnvironmentVariableW(L"TTASKS_PACKAGE", NULL);
    }
    free(name);
}

/*
 * --replace <new> <target>: renames <new> over <target> in one call with POSIX semantics
 * (A2 3.12.3 step 9). Lab row S08 records whether Windows allows it for a running launcher.
 */
static int replace_file(const wchar_t *source, const wchar_t *target) {
    wchar_t *full = new_path();
    DWORD length = GetFullPathNameW(target, PATH_CAP, full, NULL);
    size_t bytes, size;
    TTASKS_RENAME_INFO *info;
    HANDLE h;
    BOOL ok;
    if (length == 0 || length >= PATH_CAP) {
        say(L"ttasks: cannot resolve %s\n", target);
        return EXIT_SOFTWARE;
    }
    h = CreateFileW(source, DELETE | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        say(L"ttasks: cannot open %s (error %lu)\n", source, GetLastError());
        return 1;
    }
    bytes = wcslen(full) * sizeof(wchar_t);
    size = sizeof(TTASKS_RENAME_INFO) + bytes;
    info = (TTASKS_RENAME_INFO *)calloc(1, size);
    if (info == NULL) {
        CloseHandle(h);
        return EXIT_SOFTWARE;
    }
    info->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
    info->RootDirectory = NULL;
    info->FileNameLength = (DWORD)bytes;
    memcpy(info->FileName, full, bytes);
    ok = SetFileInformationByHandle(h, TTASKS_FILE_RENAME_INFO_EX, info, (DWORD)size);
    if (!ok) say(L"ttasks: Windows refused to replace %s (error %lu)\n", full, GetLastError());
    CloseHandle(h);
    free(info);
    free(full);
    return ok ? 0 : 1;
}

#ifndef TTASKS_GUI
/*
 * Ctrl+C and Ctrl+Break go to the whole console group, so Node receives them too and decides.
 * The launcher only stays alive to report Node's exit code. A handler function is used instead
 * of SetConsoleCtrlHandler(NULL, TRUE), because that flag is inherited by the child process.
 */
static BOOL WINAPI ignore_ctrl(DWORD type) {
    return type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT;
}

#ifdef TTASKS_TEST_HOOKS
/*
 * Test builds only, never a release: TTASKS_TEST_JOB_FAIL names one step of the job setup
 * (create, limits, assign, resume) that then fails as if Windows had refused it.
 */
static int simulated_failure(const wchar_t *step) {
    wchar_t value[16];
    DWORD n = GetEnvironmentVariableW(L"TTASKS_TEST_JOB_FAIL", value, _countof(value));
    if (n == 0 || n >= _countof(value) || wcscmp(value, step) != 0) return 0;
    SetLastError(ERROR_ACCESS_DENIED);
    return 1;
}
#else
static int simulated_failure(const wchar_t *step) {
    (void)step;
    return 0;
}
#endif

/*
 * The job that Node runs in: it closes with this launcher, so an agent app that kills the bridge
 * it started also kills Node. Silent breakaway keeps Node's own children out of the job: Node
 * manages them, and a detached run must outlive the CLI call that started it. Returns NULL and
 * names the failed call in *step if Windows refuses.
 */
static HANDLE new_job(const wchar_t **step) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    HANDLE job = simulated_failure(L"create") ? NULL : CreateJobObjectW(NULL, NULL);
    if (job == NULL) {
        *step = L"CreateJobObject";
        return NULL;
    }
    ZeroMemory(&limits, sizeof limits);
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    if (simulated_failure(L"limits") ||
        !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
        *step = L"SetInformationJobObject";
        return NULL;
    }
    return job;
}
#endif

static void inheritable(HANDLE h) {
    if (h != NULL && h != INVALID_HANDLE_VALUE) {
        SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
}

int wmain(int argc, wchar_t **argv) {
    wchar_t *self = new_path();
    wchar_t *version_dir;
    wchar_t *root;
    wchar_t *parent;
    wchar_t *node;
    wchar_t *entry;
    wchar_t *marker;
    wchar_t *cmdline;
    wchar_t version[65];
    const wchar_t *mode;
    const wchar_t *tail;
    const wchar_t *parent_name;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD flags = CREATE_UNICODE_ENVIRONMENT;
    DWORD code = EXIT_SOFTWARE;
    DWORD length;
#ifndef TTASKS_GUI
    HANDLE job;
    const wchar_t *step = NULL;
#endif

    if (argc >= 2 && wcscmp(argv[1], L"--package-info") == 0) return package_info();
    if (argc >= 2 && wcscmp(argv[1], L"--replace") == 0) {
        if (argc != 4) {
            say(L"usage: ttasks --replace <new> <target>\n");
            return EXIT_USAGE;
        }
        return replace_file(argv[2], argv[3]);
    }

    length = GetModuleFileNameW(NULL, self, PATH_CAP);
    if (length == 0 || length >= PATH_CAP) {
        say(L"ttasks: cannot find the launcher's own path\n");
        return EXIT_SOFTWARE;
    }

    /* P: the parent of the launcher's own folder. */
    version_dir = new_path();
    wcscpy_s(version_dir, PATH_CAP, self);
    if (cut_last(version_dir) == NULL || cut_last(version_dir) == NULL) {
        say(L"ttasks: unexpected launcher location %s\n", self);
        return EXIT_SOFTWARE;
    }
    parent = new_path();
    wcscpy_s(parent, PATH_CAP, version_dir);
    cut_last(parent);
    parent_name = wcsrchr(parent, L'\\');
    parent_name = parent_name == NULL ? parent : parent_name + 1;
    marker = join(version_dir, L"manifest.json");

    root = new_path();
    if (_wcsicmp(parent_name, L"versions") == 0 && is_file(marker)) {
        mode = L"version";
        wcscpy_s(root, PATH_CAP, parent);
        cut_last(root);
    } else {
        wchar_t *versions;
        mode = L"stable";
        wcscpy_s(root, PATH_CAP, version_dir);
        if (!read_current(root, version)) return EXIT_SOFTWARE;
        versions = join(root, L"versions");
        free(version_dir);
        version_dir = join(versions, version);
        free(versions);
    }
    free(marker);

    node = join(version_dir, L"runtime\\node.exe");
    entry = join(version_dir, L"lib\\ttasks.mjs");
    if (!is_file(node)) {
        say(L"ttasks: missing %s\n", node);
        return EXIT_SOFTWARE;
    }
    if (!is_file(entry)) {
        say(L"ttasks: missing %s\n", entry);
        return EXIT_SOFTWARE;
    }

    SetEnvironmentVariableW(L"NODE_OPTIONS", NULL);
    SetEnvironmentVariableW(L"NODE_PATH", NULL);
    SetEnvironmentVariableW(L"TTASKS_ROOT", root);
    SetEnvironmentVariableW(L"TTASKS_LAUNCHER", self);
    SetEnvironmentVariableW(L"TTASKS_LAUNCH_MODE", mode);
    set_package_variable();
    marker = join(root, L"home.marker");
    if (is_file(marker)) SetEnvironmentVariableW(L"TTASKS_HOME", root);
    free(marker);

    tail = command_tail(GetCommandLineW());
    cmdline = (wchar_t *)calloc(CMDLINE_CAP + 1, sizeof(wchar_t));
    if (cmdline == NULL) return EXIT_SOFTWARE;
    if (_snwprintf_s(cmdline, CMDLINE_CAP + 1, _TRUNCATE, L"\"%s\" --report-exclude-env \"%s\"%s%s",
                     node, entry, *tail != L'\0' ? L" " : L"", tail) < 0) {
        say(L"ttasks: the command line is too long for Windows\n");
        return EXIT_SOFTWARE;
    }

    ZeroMemory(&si, sizeof si);
    ZeroMemory(&pi, sizeof pi);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    inheritable(si.hStdInput);
    inheritable(si.hStdOutput);
    inheritable(si.hStdError);

#ifdef TTASKS_GUI
    flags |= CREATE_NO_WINDOW;
#else
    /*
     * Fail closed: Node runs only inside the job (A2 3.12.3 step 5). The job is ready before Node
     * exists, and Node starts suspended, so a refusal at any step stops it before it runs.
     */
    job = new_job(&step);
    if (job == NULL) {
        say(L"ttasks: cannot create the job object for Node (%s, error %lu). Node did not start.\n",
            step, GetLastError());
        return EXIT_SOFTWARE;
    }
    flags |= CREATE_SUSPENDED;
    /* Without any console (a detached start), keep Node from opening a console window. */
    if (GetConsoleCP() == 0) flags |= CREATE_NO_WINDOW;
    SetConsoleCtrlHandler(ignore_ctrl, TRUE);
#endif

    if (!CreateProcessW(node, cmdline, NULL, NULL, TRUE, flags, NULL, NULL, &si, &pi)) {
        say(L"ttasks: cannot start %s (error %lu)\n", node, GetLastError());
        return EXIT_SOFTWARE;
    }

#ifndef TTASKS_GUI
    step = NULL;
    if (simulated_failure(L"assign") || !AssignProcessToJobObject(job, pi.hProcess)) {
        step = L"AssignProcessToJobObject";
    } else if (simulated_failure(L"resume") || ResumeThread(pi.hThread) == (DWORD)-1) {
        step = L"ResumeThread";
    }
    if (step != NULL) {
        DWORD error = GetLastError();
        TerminateProcess(pi.hProcess, EXIT_SOFTWARE);
        WaitForSingleObject(pi.hProcess, INFINITE);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        say(L"ttasks: cannot run Node inside its job object (%s, error %lu). Node was stopped "
            L"before it ran.\n", step, error);
        return EXIT_SOFTWARE;
    }
#endif

    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    if (!GetExitCodeProcess(pi.hProcess, &code)) code = EXIT_SOFTWARE;
    CloseHandle(pi.hProcess);
    return (int)code;
}
