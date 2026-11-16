/*
 * jobhold.exe <name>: opens the job Local\<name> for query, prints "held", and keeps the handle
 * until its stdin closes. A test uses it to show that an open job handle keeps a run alive after
 * its holder died, and that recovery still ends it.
 */
#include <windows.h>
#include <stdio.h>

int wmain(int argc, wchar_t **argv) {
    wchar_t path[300];
    char buf[64];
    DWORD n;
    HANDLE job;
    if (argc != 2) return 64;
    swprintf_s(path, 300, L"Local\\%s", argv[1]);
    job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, path);
    if (job == NULL) {
        printf("error %lu\n", GetLastError());
        return 1;
    }
    printf("held\n");
    fflush(stdout);
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, sizeof buf, &n, NULL) && n > 0) {
    }
    CloseHandle(job);
    return 0;
}
