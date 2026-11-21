/*
 * Canary stand-in for the packaging spike's tamper tests (src/checks.ts). Never shipped, never in
 * a release archive. The tests put this program in place of bin\ttasks.exe, bin\ttasksw.exe and
 * runtime\node.exe in a look-alike archive or a tampered version folder. Run in any way, with any
 * arguments and any environment, it writes a file named after itself into TTASKS_CANARY_DIR and
 * exits 0 without printing anything. The tests then require that folder to stay empty.
 *
 * TTASKS_CANARY_DIR is fixed at compile time by a generated wrapper (checks.ts, prepareCanary), so
 * the canary fires even when the program runs with a cleaned environment.
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#ifndef TTASKS_CANARY_DIR
#error "compile through the wrapper that defines TTASKS_CANARY_DIR"
#endif

#define CAP 32768

static wchar_t self[CAP];
static wchar_t path[CAP];
static char text[3 * CAP];

int wmain(void) {
    const wchar_t *name;
    HANDLE h;
    DWORD written = 0;
    int n;
    DWORD length = GetModuleFileNameW(NULL, self, CAP);
    if (length == 0 || length >= CAP) return 0;
    name = wcsrchr(self, L'\\');
    name = name == NULL ? self : name + 1;
    CreateDirectoryW(TTASKS_CANARY_DIR, NULL);
    if (_snwprintf_s(path, CAP, _TRUNCATE, L"%s\\%s-%lu", TTASKS_CANARY_DIR, name,
                     GetCurrentProcessId()) < 0) {
        return 0;
    }
    h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    /* The command line, for whoever reads a failed test. */
    n = WideCharToMultiByte(CP_UTF8, 0, GetCommandLineW(), -1, text, (int)sizeof text, NULL, NULL);
    if (n > 1) WriteFile(h, text, (DWORD)(n - 1), &written, NULL);
    CloseHandle(h);
    return 0;
}
