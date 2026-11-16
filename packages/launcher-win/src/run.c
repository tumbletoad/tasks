/*
 * tasks-run.exe: the holder of one background run's job object on Windows.
 *
 *   tasks-run.exe start <name> <program> <command line>
 *   tasks-run.exe confirm <name>
 *   tasks-run.exe end <name>
 *
 * start creates the job Local\<name> (a name that exists is refused), with kill on close and no
 * breakaway, and starts <program> with <command line> already inside it: no moment exists in
 * which the agent runs outside the job, so neither it nor anything it starts, detached or not,
 * can leave. The agent gets its own console without a window, stdin on NUL, this process's
 * stdout and stderr, and no other handle. This process holds the only handle to the job, so when
 * it ends, however it ends, Windows ends every process in the job. The service starts it as a
 * plain child, so it ends with the service.
 *
 * fd 3 carries commands from the service, fd 4 events to it, one line each:
 *   commands  "interrupt"  Ctrl+C to the agent's console
 *             "kill"       end every process in the job
 *             end of file  the service ended or let go: end every process in the job and exit
 *   events    "pid <n>"                 the agent runs, inside the job
 *             "exit <code>"             the agent itself exited
 *             "interrupt <ok> <error>"  the answer to "interrupt" (ok is 1 or 0)
 *             "kill <ok> <error>"       the answer to "kill"
 *             "empty"                   no process is left in the job; the helper then exits 0
 *             "error <step> <code>"     the start failed at that step, before the agent ran
 *
 * confirm opens the job by name, reads its count of active processes and closes it at once: an
 * open handle anywhere keeps a job and its processes alive. It prints "gone" when no job has the
 * name (error 2), "active <n>", or "error <code>", and exits 0 when the job is gone or empty, 1
 * when processes remain and 2 when it cannot tell. end does the same after ending every process
 * in the job, waiting up to 5 s for the count to reach 0.
 *
 * Exit codes of start: 0 after "empty" or end of file, 64 bad arguments, 65 no fd 3 or 4, 66 the
 * job was refused or exists, 67 the agent could not start.
 */
#include <windows.h>
#include <io.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define EXIT_USAGE 64
#define EXIT_NO_CONTROL 65
#define EXIT_JOB 66
#define EXIT_SPAWN 67

/* The exit code Windows gives a process the job ends. */
#define KILLED_CODE 1

#define NAME_MAX_CHARS 200
#define END_WAIT_MS 5000
/* How often the loop reads the job's count itself: Windows does not promise every job message. */
#define POLL_MS 200

#define KEY_JOB 1
#define KEY_INTERRUPT 2
#define KEY_KILL 3
#define KEY_AGENT_EXIT 4
#define KEY_CONTROL_CLOSED 5

static HANDLE port;
static HANDLE events;
static HANDLE agent;

static int print(const char *fmt, ...) {
    char line[160];
    DWORD written;
    int n;
    va_list ap;
    va_start(ap, fmt);
    n = _vsnprintf_s(line, sizeof line, _TRUNCATE, fmt, ap);
    va_end(ap);
    if (n < 0) return 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line, (DWORD)n, &written, NULL);
}

/* Writes one event line. 0 when the service no longer reads them. */
static int emit(const char *fmt, ...) {
    char line[160];
    DWORD written;
    int n;
    va_list ap;
    va_start(ap, fmt);
    n = _vsnprintf_s(line, sizeof line, _TRUNCATE, fmt, ap);
    va_end(ap);
    if (n < 0) return 0;
    return WriteFile(events, line, (DWORD)n, &written, NULL) && written == (DWORD)n;
}

/* A name of ASCII letters, digits, '-', '_' and '.', starting with a letter or digit. */
static int valid_name(const wchar_t *name) {
    size_t i, n = wcslen(name);
    if (n == 0 || n > NAME_MAX_CHARS) return 0;
    for (i = 0; i < n; i++) {
        wchar_t c = name[i];
        int alnum = (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9');
        if (!alnum && (i == 0 || (c != L'-' && c != L'_' && c != L'.'))) return 0;
    }
    return 1;
}

static void job_path(const wchar_t *name, wchar_t *path, size_t cap) {
    swprintf_s(path, cap, L"Local\\%s", name);
}

static int active_count(HANDLE job, DWORD *active) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof info,
                                   NULL)) {
        return 0;
    }
    *active = info.ActiveProcesses;
    return 1;
}

/* Ends every process in the job and waits up to END_WAIT_MS for the count to reach 0. */
static int end_job(HANDLE job, DWORD *active) {
    ULONGLONG deadline = GetTickCount64() + END_WAIT_MS;
    if (!TerminateJobObject(job, KILLED_CODE)) return 0;
    for (;;) {
        if (!active_count(job, active)) return 0;
        if (*active == 0 || GetTickCount64() >= deadline) return 1;
        Sleep(5);
    }
}

static int confirm(const wchar_t *name, int end) {
    wchar_t path[NAME_MAX_CHARS + 16];
    DWORD active = 0;
    DWORD error;
    int ok;
    HANDLE job;
    job_path(name, path, _countof(path));
    job = OpenJobObjectW(JOB_OBJECT_QUERY | (end ? JOB_OBJECT_TERMINATE : 0), FALSE, path);
    if (job == NULL) {
        error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND) {
            print("gone\n");
            return 0;
        }
        print("error %lu\n", error);
        return 2;
    }
    ok = end ? end_job(job, &active) : active_count(job, &active);
    error = GetLastError();
    CloseHandle(job);
    if (!ok) {
        print("error %lu\n", error);
        return 2;
    }
    print("active %lu\n", active);
    return active == 0 ? 0 : 1;
}



/* Sends Ctrl+C to every process on the agent's console. Returns 0, or the refused call's error. */
static DWORD interrupt(DWORD pid) {
    DWORD error = 0;
    FreeConsole();
    if (!AttachConsole(pid)) return GetLastError();
    if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)) error = GetLastError();
    FreeConsole();
    return error;
}

static void post(ULONG_PTR key) {
    PostQueuedCompletionStatus(port, 0, key, NULL);
}

/* Reads commands from fd 3 until it closes. Unknown or overlong lines are ignored. */
static DWORD WINAPI read_commands(LPVOID arg) {
    HANDLE in = (HANDLE)arg;
    char buf[256];
    char line[32];
    size_t used = 0;
    int overlong = 0;
    DWORD n, i;
    for (;;) {
        if (!ReadFile(in, buf, sizeof buf, &n, NULL)) break;
        for (i = 0; i < n; i++) {
            if (buf[i] != '\n') {
                if (used < sizeof line - 1) {
                    line[used++] = buf[i];
                } else {
                    overlong = 1;
                }
                continue;
            }
            line[used] = '\0';
            if (!overlong && strcmp(line, "interrupt") == 0) post(KEY_INTERRUPT);
            if (!overlong && strcmp(line, "kill") == 0) post(KEY_KILL);
            used = 0;
            overlong = 0;
        }
    }
    post(KEY_CONTROL_CLOSED);
    return 0;
}

static DWORD WINAPI wait_agent(LPVOID arg) {
    (void)arg;
    WaitForSingleObject(agent, INFINITE);
    post(KEY_AGENT_EXIT);
    return 0;
}

static HANDLE control_handle(int fd) {
    intptr_t raw = _get_osfhandle(fd);
    HANDLE h = (HANDLE)raw;
    if (raw == -1 || raw == -2 || raw == 0) return NULL;
    /* Only the three standard handles reach the agent: the attribute list says so, and so does
       this. */
    SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
    return h;
}

/* An inheritable copy of a standard handle, or an inheritable handle to NUL when it has none. */
static HANDLE agent_handle(DWORD which) {
    HANDLE own = which == STD_INPUT_HANDLE ? NULL : GetStdHandle(which);
    HANDLE copy = NULL;
    SECURITY_ATTRIBUTES inherit = {sizeof inherit, NULL, TRUE};
    if (own != NULL && own != INVALID_HANDLE_VALUE &&
        DuplicateHandle(GetCurrentProcess(), own, GetCurrentProcess(), &copy, 0, TRUE,
                        DUPLICATE_SAME_ACCESS)) {
        return copy;
    }
    copy = CreateFileW(L"NUL", which == STD_INPUT_HANDLE ? GENERIC_READ : GENERIC_WRITE,
                       FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, NULL);
    return copy == INVALID_HANDLE_VALUE ? NULL : copy;
}

static HANDLE create_job(const wchar_t *name) {
    wchar_t path[NAME_MAX_CHARS + 16];
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT link;
    HANDLE job;
    job_path(name, path, _countof(path));
    job = CreateJobObjectW(NULL, path);
    if (job == NULL) {
        emit("error job %lu\n", GetLastError());
        return NULL;
    }
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(job);
        emit("error exists %lu\n", (DWORD)ERROR_ALREADY_EXISTS);
        return NULL;
    }
    ZeroMemory(&limits, sizeof limits);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    link.CompletionKey = (PVOID)(ULONG_PTR)KEY_JOB;
    link.CompletionPort = port;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits) ||
        !SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &link,
                                 sizeof link)) {
        emit("error limits %lu\n", GetLastError());
        CloseHandle(job);
        return NULL;
    }
    return job;
}

/* Starts the agent inside the job. Returns its process ID, or 0 after an "error" event. */
static DWORD start_agent(HANDLE job, const wchar_t *program, const wchar_t *command_line) {
    STARTUPINFOEXW si;
    PROCESS_INFORMATION pi;
    HANDLE std[3];
    HANDLE jobs[1];
    LPPROC_THREAD_ATTRIBUTE_LIST attributes;
    SIZE_T size = 0;
    DWORD error = 0;
    const char *step = NULL;
    wchar_t *line;
    size_t length = wcslen(command_line) + 1;
    int initialized = 0;
    int i;

    ZeroMemory(&si, sizeof si);
    ZeroMemory(&pi, sizeof pi);
    line = (wchar_t *)calloc(length, sizeof(wchar_t));
    std[0] = agent_handle(STD_INPUT_HANDLE);
    std[1] = agent_handle(STD_OUTPUT_HANDLE);
    std[2] = agent_handle(STD_ERROR_HANDLE);
    jobs[0] = job;
    InitializeProcThreadAttributeList(NULL, 2, 0, &size);
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)calloc(1, size);
    if (line == NULL || attributes == NULL || std[0] == NULL || std[1] == NULL || std[2] == NULL) {
        step = "handles";
        error = GetLastError();
    } else if (!(initialized = InitializeProcThreadAttributeList(attributes, 2, 0, &size))) {
        step = "attributes";
        error = GetLastError();
    } else if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs,
                                          sizeof jobs, NULL, NULL) ||
               !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, std,
                                          sizeof std, NULL, NULL)) {
        step = "attributes";
        error = GetLastError();
    } else {
        wcscpy_s(line, length, command_line);
        si.StartupInfo.cb = sizeof si;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = std[0];
        si.StartupInfo.hStdOutput = std[1];
        si.StartupInfo.hStdError = std[2];
        si.lpAttributeList = attributes;
        if (!CreateProcessW(program, line, NULL, NULL, TRUE,
                            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW |
                                CREATE_UNICODE_ENVIRONMENT,
                            NULL, NULL, &si.StartupInfo, &pi)) {
            step = "spawn";
            error = GetLastError();
        }
    }
    if (initialized) DeleteProcThreadAttributeList(attributes);
    free(attributes);
    free(line);
    for (i = 0; i < 3; i++) {
        if (std[i] != NULL) CloseHandle(std[i]);
    }
    if (step != NULL) {
        emit("error %s %lu\n", step, error);
        return 0;
    }
    CloseHandle(pi.hThread);
    agent = pi.hProcess;
    return pi.dwProcessId;
}

static int run(const wchar_t *name, const wchar_t *program, const wchar_t *command_line) {
    HANDLE commands = control_handle(3);
    HANDLE job;
    DWORD pid, active = 0;
    int agent_exited = 0;
    events = control_handle(4);
    if (commands == NULL || events == NULL) return EXIT_NO_CONTROL;
    /* The agent inherits whether Ctrl+C is ignored, and whoever started the service may have set
       that: it is cleared for the agent, then set again for the helper, which attaches to the
       agent's console to send Ctrl+C and must not end on it. */
    SetConsoleCtrlHandler(NULL, FALSE);
    port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
    if (port == NULL) {
        emit("error port %lu\n", GetLastError());
        return EXIT_JOB;
    }
    /* Never closed by hand: when this process ends, the job's kill on close ends its processes. */
    job = create_job(name);
    if (job == NULL) return EXIT_JOB;
    pid = start_agent(job, program, command_line);
    if (pid == 0) return EXIT_SPAWN;
    SetConsoleCtrlHandler(NULL, TRUE);
    if (!emit("pid %lu\n", pid) ||
        CreateThread(NULL, 64 * 1024, read_commands, commands, 0, NULL) == NULL ||
        CreateThread(NULL, 64 * 1024, wait_agent, NULL, 0, NULL) == NULL) {
        end_job(job, &active);
        return 0;
    }
    for (;;) {
        DWORD bytes = 0, code = 0, error = 0;
        ULONG_PTR key = 0;
        LPOVERLAPPED overlapped = NULL;
        int empty = 0;
        int sent = 1;
        if (!GetQueuedCompletionStatus(port, &bytes, &key, &overlapped, POLL_MS)) {
            empty = active_count(job, &active) && active == 0;
        } else if (key == KEY_JOB) {
            empty = bytes == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO;
        } else if (key == KEY_AGENT_EXIT) {
            if (!agent_exited) {
                agent_exited = 1;
                if (!GetExitCodeProcess(agent, &code)) code = KILLED_CODE;
                sent = emit("exit %lu\n", code);
            }
        } else if (key == KEY_INTERRUPT) {
            error = interrupt(pid);
            sent = emit("interrupt %d %lu\n", error == 0, error);
        } else if (key == KEY_KILL) {
            if (!TerminateJobObject(job, KILLED_CODE)) error = GetLastError();
            sent = emit("kill %d %lu\n", error == 0, error);
        } else if (key == KEY_CONTROL_CLOSED) {
            end_job(job, &active);
            return 0;
        }
        if (!sent) {
            /* The service no longer reads: it ended, so the run ends too. */
            end_job(job, &active);
            return 0;
        }
        if (empty) {
            if (!agent_exited) {
                WaitForSingleObject(agent, INFINITE);
                if (!GetExitCodeProcess(agent, &code)) code = KILLED_CODE;
                emit("exit %lu\n", code);
            }
            emit("empty\n");
            return 0;
        }
    }
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 5 && wcscmp(argv[1], L"start") == 0 && valid_name(argv[2])) {
        return run(argv[2], argv[3], argv[4]);
    }
    if (argc == 3 && wcscmp(argv[1], L"confirm") == 0 && valid_name(argv[2])) {
        return confirm(argv[2], 0);
    }
    if (argc == 3 && wcscmp(argv[1], L"end") == 0 && valid_name(argv[2])) {
        return confirm(argv[2], 1);
    }
    print("usage: tasks-run start <name> <program> <command line> | confirm <name> | end <name>\n");
    return EXIT_USAGE;
}
