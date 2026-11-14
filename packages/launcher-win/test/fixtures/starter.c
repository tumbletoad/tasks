/*
 * Test fixture: starts a program the way an unusual parent might, with chosen standard handles,
 * an unrelated inheritable handle and raw environment entries (a name may appear twice).
 *
 *   starter <stdin> <stdout> <stderr> <stray file | -> <program> [NAME=VALUE ...] -- [arg ...]
 *
 * A handle is one of: inherit (the starter's own), null, invalid (INVALID_HANDLE_VALUE), bogus
 * (a value that names no handle, as a closed one would) or file:<path> (read for stdin, created
 * for stdout and stderr). For stderr only, stdout gives it the very handle value stdout got, as
 * "> out.log 2>&1" does. The stray file is created and held open through an inheritable handle
 * for the whole run. The entries are appended to the starter's own environment block as they
 * are. The program's command line is its quoted path and the arguments joined by spaces.
 * Exits with the program's exit code, or 90 to 99 when the starter itself fails.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static HANDLE handle_for(const wchar_t *spec, DWORD which) {
    SECURITY_ATTRIBUTES inherit = {sizeof inherit, NULL, TRUE};
    int input = which == STD_INPUT_HANDLE;
    if (wcscmp(spec, L"null") == 0) return NULL;
    if (wcscmp(spec, L"invalid") == 0) return INVALID_HANDLE_VALUE;
    if (wcscmp(spec, L"bogus") == 0) return (HANDLE)(ULONG_PTR)0x7ff0;
    if (wcscmp(spec, L"inherit") == 0) {
        HANDLE h = GetStdHandle(which);
        if (h != NULL && h != INVALID_HANDLE_VALUE) {
            SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
        return h;
    }
    if (wcsncmp(spec, L"file:", 5) == 0) {
        HANDLE h = CreateFileW(spec + 5, input ? GENERIC_READ : GENERIC_WRITE,
                               FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit,
                               input ? OPEN_EXISTING : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (h == INVALID_HANDLE_VALUE) ExitProcess(91);
        return h;
    }
    ExitProcess(92);
}

int wmain(int argc, wchar_t **argv) {
    SECURITY_ATTRIBUTES inherit = {sizeof inherit, NULL, TRUE};
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    wchar_t *block, *env, *cmd, *at;
    const wchar_t *p;
    size_t block_len, extra_len = 0, cmd_len;
    int i, dashes;
    DWORD code = 99;

    if (argc < 6) return 90;
    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = handle_for(argv[1], STD_INPUT_HANDLE);
    si.hStdOutput = handle_for(argv[2], STD_OUTPUT_HANDLE);
    si.hStdError =
        wcscmp(argv[3], L"stdout") == 0 ? si.hStdOutput : handle_for(argv[3], STD_ERROR_HANDLE);
    if (wcscmp(argv[4], L"-") != 0 &&
        CreateFileW(argv[4], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    &inherit, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL) == INVALID_HANDLE_VALUE) {
        return 93;
    }

    for (dashes = 6; dashes < argc && wcscmp(argv[dashes], L"--") != 0; dashes++) {
        extra_len += wcslen(argv[dashes]) + 1;
    }
    block = GetEnvironmentStringsW();
    if (block == NULL) return 94;
    for (p = block; *p != L'\0'; p += wcslen(p) + 1) {
    }
    block_len = (size_t)(p - block);
    env = (wchar_t *)calloc(block_len + extra_len + 2, sizeof(wchar_t));
    if (env == NULL) return 95;
    memcpy(env, block, block_len * sizeof(wchar_t));
    FreeEnvironmentStringsW(block);
    at = env + block_len;
    for (i = 6; i < dashes; i++) {
        size_t len = wcslen(argv[i]);
        memcpy(at, argv[i], len * sizeof(wchar_t));
        at += len + 1;
    }

    cmd_len = wcslen(argv[5]) + 3;
    for (i = dashes + 1; i < argc; i++) cmd_len += wcslen(argv[i]) + 1;
    cmd = (wchar_t *)calloc(cmd_len + 1, sizeof(wchar_t));
    if (cmd == NULL) return 95;
    wcscat_s(cmd, cmd_len + 1, L"\"");
    wcscat_s(cmd, cmd_len + 1, argv[5]);
    wcscat_s(cmd, cmd_len + 1, L"\"");
    for (i = dashes + 1; i < argc; i++) {
        wcscat_s(cmd, cmd_len + 1, L" ");
        wcscat_s(cmd, cmd_len + 1, argv[i]);
    }

    if (!CreateProcessW(argv[5], cmd, NULL, NULL, TRUE,
                        CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, NULL, &si, &pi)) {
        return 96;
    }
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    if (!GetExitCodeProcess(pi.hProcess, &code)) code = 97;
    CloseHandle(pi.hProcess);
    return (int)code;
}
