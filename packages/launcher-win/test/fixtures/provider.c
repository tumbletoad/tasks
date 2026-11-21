/*
 * Test fixture: a stand-in OpenSSL provider DLL. Loading it writes "loaded" to the file that
 * TTASKS_FIXTURE_MARKER names, so a test sees whether any process loaded it. It offers no
 * algorithms, so a process that loads it carries on normally.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        wchar_t path[1024];
        DWORD n = GetEnvironmentVariableW(L"TTASKS_FIXTURE_MARKER", path, ARRAYSIZE(path));
        if (n > 0 && n < ARRAYSIZE(path)) {
            HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                                   FILE_ATTRIBUTE_NORMAL, NULL);
            if (h != INVALID_HANDLE_VALUE) {
                DWORD written = 0;
                WriteFile(h, "loaded", 6, &written, NULL);
                CloseHandle(h);
            }
        }
    }
    return TRUE;
}

/* OSSL_DISPATCH: a function ID and a function. An empty table offers nothing. */
typedef struct {
    int function_id;
    void (*function)(void);
} Dispatch;

static const Dispatch nothing[] = {{0, NULL}};

__declspec(dllexport) int OSSL_provider_init(const void *handle, const Dispatch *in,
                                             const Dispatch **out, void **provctx) {
    (void)handle;
    (void)in;
    *out = nothing;
    *provctx = NULL;
    return 1;
}
