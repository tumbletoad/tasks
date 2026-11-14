/*
 * Test fixture: a stand-in node.exe that reports which handles it received. It writes one JSON
 * object to the file TASKS_FIXTURE_REPORT names:
 *   stdin, stdout, stderr  "none" (no handle), "bad" (a value that is no usable handle), or the
 *                          handle's type: "disk", "pipe", "char", "unknown"
 *   stray                  how many of its handles refer to the file whose name ends with
 *                          TASKS_FIXTURE_STRAY. It writes "LEAK" through each one it finds.
 *   input                  up to 63 bytes read from stdin when stdin is a file
 * It writes "out\n" to stdout and "err\n" to stderr where it has them, and exits 0.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static const char *describe(HANDLE h) {
    DWORD type;
    if (h == NULL || h == INVALID_HANDLE_VALUE) return "none";
    SetLastError(NO_ERROR);
    type = GetFileType(h);
    if (type == FILE_TYPE_UNKNOWN && GetLastError() != NO_ERROR) return "bad";
    switch (type) {
    case FILE_TYPE_DISK:
        return "disk";
    case FILE_TYPE_PIPE:
        return "pipe";
    case FILE_TYPE_CHAR:
        return "char";
    default:
        return "unknown";
    }
}

/* Looks at every possible handle value of this small process for the stray file. */
static int find_stray(const wchar_t *name) {
    wchar_t path[1024];
    size_t name_len = wcslen(name);
    ULONG_PTR value;
    int found = 0;
    for (value = 4; value < 0x10000; value += 4) {
        HANDLE h = (HANDLE)value;
        DWORD n;
        size_t len;
        if (GetFileType(h) != FILE_TYPE_DISK) continue;
        n = GetFinalPathNameByHandleW(h, path, ARRAYSIZE(path), FILE_NAME_NORMALIZED);
        if (n == 0 || n >= ARRAYSIZE(path)) continue;
        len = wcslen(path);
        if (len >= name_len && _wcsicmp(path + len - name_len, name) == 0) {
            DWORD written = 0;
            WriteFile(h, "LEAK", 4, &written, NULL);
            found++;
        }
    }
    return found;
}

static void write_text(HANDLE h, const char *text) {
    DWORD written = 0;
    if (h != NULL && h != INVALID_HANDLE_VALUE) WriteFile(h, text, (DWORD)strlen(text), &written, NULL);
}

int wmain(void) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
    const char *in_kind = describe(in);
    const char *out_kind = describe(out);
    const char *err_kind = describe(err);
    wchar_t stray_name[512];
    wchar_t report_path[1024];
    char input[64] = "";
    char json[512];
    DWORD got = 0, n;
    int stray = 0;
    HANDLE report;

    n = GetEnvironmentVariableW(L"TASKS_FIXTURE_STRAY", stray_name, ARRAYSIZE(stray_name));
    if (n > 0 && n < ARRAYSIZE(stray_name)) stray = find_stray(stray_name);
    if (strcmp(in_kind, "disk") == 0 && ReadFile(in, input, sizeof input - 1, &got, NULL)) {
        input[got] = '\0';
    }
    if (strcmp(out_kind, "none") != 0 && strcmp(out_kind, "bad") != 0) write_text(out, "out\n");
    if (strcmp(err_kind, "none") != 0 && strcmp(err_kind, "bad") != 0) write_text(err, "err\n");

    _snprintf_s(json, sizeof json, _TRUNCATE,
                "{\"stdin\":\"%s\",\"stdout\":\"%s\",\"stderr\":\"%s\",\"stray\":%d,\"input\":\"%s\"}",
                in_kind, out_kind, err_kind, stray, input);
    n = GetEnvironmentVariableW(L"TASKS_FIXTURE_REPORT", report_path, ARRAYSIZE(report_path));
    if (n == 0 || n >= ARRAYSIZE(report_path)) return 2;
    report = CreateFileW(report_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                         NULL);
    if (report == INVALID_HANDLE_VALUE) return 3;
    write_text(report, json);
    CloseHandle(report);
    return 0;
}
