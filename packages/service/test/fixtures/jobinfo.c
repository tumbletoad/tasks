/*
 * jobinfo.exe <file>: writes to <file> whether this process is in a job and, when it is, its
 * immediate job's limit flags (JOBOBJECT_EXTENDED_LIMIT_INFORMATION):
 *   {"inJob":true,"flags":<LimitFlags>}  or  {"inJob":false,"flags":null}
 * The service install's Explorer test starts it from the service, detached, so it shares the
 * service's jobs and tells whether its immediate job would kill the service when it closes.
 *
 * jobinfo.exe --pid <pid> <file>: writes {"inJob":<bool>} for another process. The test asks it
 * about Explorer: a process Explorer starts is in Explorer's own jobs too, unless it breaks away,
 * so with Explorer in no job the immediate job above is the whole chain (nested jobs, Microsoft
 * Learn), and its flags are all there is to check.
 */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int other(const wchar_t *pid_text, const wchar_t *path) {
    BOOL in = FALSE;
    FILE *out = NULL;
    wchar_t *end = NULL;
    unsigned long pid = wcstoul(pid_text, &end, 10);
    HANDLE process;
    if (end == pid_text || *end != L'\0' || pid == 0) return 2;
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
    if (process == NULL) return 5;
    if (!IsProcessInJob(process, NULL, &in)) {
        CloseHandle(process);
        return 3;
    }
    CloseHandle(process);
    if (_wfopen_s(&out, path, L"w") != 0 || out == NULL) return 4;
    fprintf(out, "{\"inJob\":%s}\n", in ? "true" : "false");
    fclose(out);
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    BOOL in = FALSE;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
    FILE *out = NULL;
    if (argc == 4 && wcscmp(argv[1], L"--pid") == 0) return other(argv[2], argv[3]);
    if (argc != 2) return 2;
    if (!IsProcessInJob(GetCurrentProcess(), NULL, &in)) return 3;
    ZeroMemory(&info, sizeof info);
    if (_wfopen_s(&out, argv[1], L"w") != 0 || out == NULL) return 4;
    if (in && QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation, &info,
                                        sizeof info, NULL)) {
        fprintf(out, "{\"inJob\":true,\"flags\":%lu}\n", info.BasicLimitInformation.LimitFlags);
    } else {
        fprintf(out, "{\"inJob\":%s,\"flags\":null}\n", in ? "true" : "false");
    }
    fclose(out);
    return 0;
}
