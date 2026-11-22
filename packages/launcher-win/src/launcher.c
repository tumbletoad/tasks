/*
 * TTasks's Windows launchers (A2 3.12.3, 3.3.2). One source builds both:
 *   ttasks.exe   console subsystem. Runs Node once inside a kill-on-close job object and returns
 *               Node's exit code. If Windows refuses any step of the job, Node never runs (70).
 *   ttasksw.exe  GUI subsystem (TTASKS_GUI). No console window and no job object. With no
 *               arguments, from the stable bin folder, it supervises `ttasks serve`.
 * From the stable bin folder, each one puts back its sibling when an update was cut off between
 * the two renames of that launcher (repair_sibling).
 * TTASKS_TEST_HOOKS builds a test-only launcher: it can simulate a refused job step, shorten the
 * supervisor's time unit and trace the supervisor's decisions. Release builds never define it.
 *
 * README.md in this package describes the two modes, the environment, the supervisor, the exit
 * codes and every trust assumption. A2 3.12.3 states the rules, and A2 3.12.6 the update's side.
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

/* Exit codes (A2 3.3.1). The launcher itself exits 64 on bad arguments and 70 when it cannot run
 * Node. From the service, 0, 64 and 73 stop the supervisor and 75 asks for a restart. */
#define EXIT_USAGE 64
#define EXIT_SOFTWARE 70
#define EXIT_LOCKED 73
#define EXIT_RESTART 75

#define PATH_CAP 32768
/* CreateProcessW takes at most 32,767 characters, the terminating null included. */
#define CMDLINE_CAP 32767
/* The longest version name that <root>\current may hold. */
#define VERSION_MAX 64

/* The stable launchers' file names in the command folder (A2 3.12.2). Each repairs the other. */
#define CONSOLE_LAUNCHER L"ttasks.exe"
#define GUI_LAUNCHER L"ttasksw.exe"
#ifdef TTASKS_GUI
#define SIBLING_LAUNCHER CONSOLE_LAUNCHER
#else
#define SIBLING_LAUNCHER GUI_LAUNCHER
#endif
/* A launcher is a few hundred KB: the sibling repair copies nothing larger than this. */
#define LAUNCHER_MAX_BYTES (16LL * 1024 * 1024)

#ifdef TTASKS_GUI
/*
 * The supervisor's policy (A2 3.3.2): restart after 1, 2, 4 and 8 time
 * units, and give up at the 5th failure within the window. A restart that the service requests
 * (exit 75) happens at once, but more than QUICK_RESTART_LIMIT of them within the window count as
 * failures, so a service that always asks for a restart cannot spin. A time unit is one second in
 * every release build.
 */
#define TIME_UNIT_MS 1000
#define GIVE_UP_FAILURES 5
#define FAILURE_WINDOW_UNITS 600
#define QUICK_RESTART_LIMIT 5
static const DWORD RESTART_DELAY_UNITS[] = {1, 2, 4, 8};
C_ASSERT(_countof(RESTART_DELAY_UNITS) == GIVE_UP_FAILURES - 1);
#endif

/* ---- Output ---------------------------------------------------------------------------------- */

/*
 * Writes text to a standard handle, if the launcher has one: UTF-16 to a console, which shows it
 * correctly whatever its code page, and UTF-8 to a pipe or a file.
 */
static void write_to(DWORD which, const wchar_t *fmt, va_list ap) {
    wchar_t text[4096];
    char utf8[16384];
    HANDLE h = GetStdHandle(which);
    DWORD written = 0;
    DWORD mode = 0;
    int n;
    if (h == NULL || h == INVALID_HANDLE_VALUE) return;
    _vsnwprintf_s(text, _countof(text), _TRUNCATE, fmt, ap);
    if (GetConsoleMode(h, &mode)) {
        WriteConsoleW(h, text, (DWORD)wcslen(text), &written, NULL);
        return;
    }
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

/* ---- Paths ----------------------------------------------------------------------------------- */

static void *must_alloc(size_t count, size_t size) {
    void *p = calloc(count, size);
    if (p == NULL) {
        say(L"ttasks: out of memory\n");
        ExitProcess(EXIT_SOFTWARE);
    }
    return p;
}

static wchar_t *new_path(void) {
    return (wchar_t *)must_alloc(PATH_CAP, sizeof(wchar_t));
}

static wchar_t *copy_path(const wchar_t *path) {
    wchar_t *p = new_path();
    wcscpy_s(p, PATH_CAP, path);
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

/* Cuts the last component off a path in place. Returns 0 when there is none to cut. */
static int cut_last(wchar_t *path) {
    wchar_t *slash = wcsrchr(path, L'\\');
    if (slash == NULL) return 0;
    *slash = L'\0';
    return 1;
}

static const wchar_t *last_name(const wchar_t *path) {
    const wchar_t *slash = wcsrchr(path, L'\\');
    return slash == NULL ? path : slash + 1;
}

enum { KIND_MISSING, KIND_FILE, KIND_FOLDER, KIND_LINK };

/*
 * What a path names, without following it if it is a link: a symbolic link, a junction or any
 * other name-surrogate reparse point is KIND_LINK. Other reparse points (cloud files, dedup) count
 * as what they hold.
 */
static int path_kind(const wchar_t *path) {
    WIN32_FIND_DATAW data;
    HANDLE h = FindFirstFileExW(path, FindExInfoBasic, &data, FindExSearchNameMatch, NULL, 0);
    if (h == INVALID_HANDLE_VALUE) return KIND_MISSING;
    FindClose(h);
    if ((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 &&
        IsReparseTagNameSurrogate(data.dwReserved0)) {
        return KIND_LINK;
    }
    return (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? KIND_FOLDER : KIND_FILE;
}

/*
 * Requires a plain file or folder below the install root, and says why not. The launcher never
 * follows a link there, so the runtime and the bundle it starts are always inside its install.
 */
static int require(const wchar_t *path, int kind) {
    int found = path_kind(path);
    if (found == kind) return 1;
    if (found == KIND_LINK) {
        say(L"ttasks: %s is a link or junction. The launcher runs only files inside its own "
            L"install.\n", path);
    } else {
        say(L"ttasks: missing %s\n", path);
    }
    return 0;
}

/* ---- New files in the install ---------------------------------------------------------------- */

/*
 * A new, empty file in dir, <dir>\<stem>.<pid>-<tick>-<attempt>.tmp, under a name no other file
 * has: CREATE_NEW never opens, follows or truncates anything that exists, so a link or file
 * planted at a predicted name is left alone. No sharing: nothing else can open, rename or delete
 * it while it is written. path holds PATH_CAP characters.
 */
static HANDLE new_temp_file(const wchar_t *dir, const wchar_t *stem, wchar_t *path) {
    int attempt;
    for (attempt = 0; attempt < 16; attempt++) {
        HANDLE h;
        if (_snwprintf_s(path, PATH_CAP, _TRUNCATE, L"%s\\%s.%lu-%llu-%d.tmp", dir, stem,
                         GetCurrentProcessId(), GetTickCount64(), attempt) < 0) {
            break;
        }
        h = CreateFileW(path, GENERIC_WRITE | DELETE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
                        NULL);
        if (h != INVALID_HANDLE_VALUE || GetLastError() != ERROR_FILE_EXISTS) return h;
    }
    return INVALID_HANDLE_VALUE;
}

/*
 * Renames the open file h to target through its own handle, so the file that gets the name is
 * the one written. replace: whether a file at target is replaced; otherwise the rename fails.
 */
static BOOL rename_open_file(HANDLE h, const wchar_t *target, BOOL replace) {
    size_t bytes = wcslen(target) * sizeof(wchar_t);
    size_t size = sizeof(FILE_RENAME_INFO) + bytes;
    FILE_RENAME_INFO *info = (FILE_RENAME_INFO *)must_alloc(1, size);
    BOOL ok;
    info->ReplaceIfExists = replace ? TRUE : FALSE;
    info->RootDirectory = NULL;
    info->FileNameLength = (DWORD)bytes;
    memcpy(info->FileName, target, bytes);
    ok = SetFileInformationByHandle(h, FileRenameInfo, info, (DWORD)size);
    free(info);
    return ok;
}

/* Deletes the open file h when it is closed: a temporary file that did not get its name. */
static void discard_open_file(HANDLE h) {
    FILE_DISPOSITION_INFO remove = {TRUE};
    SetFileInformationByHandle(h, FileDispositionInfo, &remove, sizeof remove);
}

/* ---- The version in <root>\current ----------------------------------------------------------- */

static int is_alnum(char c) {
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static char upper(char c) {
    return (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;
}

/* CON, PRN, AUX, NUL, COM0-9 and LPT0-9, alone or before a dot, name devices on Windows. */
static int reserved_device(const char *s, DWORD n) {
    static const char *const three[] = {"CON", "PRN", "AUX", "NUL"};
    DWORD stem = 0;
    int i;
    while (stem < n && s[stem] != '.') stem++;
    if (stem == 3) {
        for (i = 0; i < (int)_countof(three); i++) {
            if (upper(s[0]) == three[i][0] && upper(s[1]) == three[i][1] &&
                upper(s[2]) == three[i][2]) {
                return 1;
            }
        }
    }
    if (stem == 4 && s[3] >= '0' && s[3] <= '9') {
        if ((upper(s[0]) == 'C' && upper(s[1]) == 'O' && upper(s[2]) == 'M') ||
            (upper(s[0]) == 'L' && upper(s[1]) == 'P' && upper(s[2]) == 'T')) {
            return 1;
        }
    }
    return 0;
}

/*
 * A version name: 1 to 64 characters from [0-9A-Za-z.+-] that start and end with a letter or
 * digit, with no two dots in a row and no device name. So "." and "..", a staging folder
 * (".staging-…"), a trailing dot (which Windows strips) and anything with a separator, a colon,
 * whitespace or a byte order mark can never name the version folder.
 */
static int valid_version(const char *s, DWORD n) {
    DWORD i;
    if (n < 1 || n > VERSION_MAX) return 0;
    if (!is_alnum(s[0]) || !is_alnum(s[n - 1])) return 0;
    for (i = 0; i < n; i++) {
        char c = s[i];
        if (!is_alnum(c) && c != '.' && c != '+' && c != '-') return 0;
        if (c == '.' && s[i - 1] == '.') return 0; /* i > 0: s[0] is a letter or digit */
    }
    return !reserved_device(s, n);
}

/*
 * Reads and validates <root>\current into version (VERSION_MAX + 1 characters). quiet: say
 * nothing when it fails (the sibling repair, before resolve reports the same problem).
 */
static int read_current(const wchar_t *root, wchar_t *version, int quiet) {
    wchar_t *path = join(root, L"current");
    char buf[VERSION_MAX + 1];
    DWORD n = 0, i;
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        if (!quiet) say(L"ttasks: cannot read %s (error %lu)\n", path, GetLastError());
        free(path);
        return 0;
    }
    if (!ReadFile(h, buf, (DWORD)sizeof buf, &n, NULL)) n = 0;
    CloseHandle(h);
    if (!valid_version(buf, n)) {
        if (!quiet) say(L"ttasks: %s does not hold a valid version\n", path);
        free(path);
        return 0;
    }
    for (i = 0; i < n; i++) version[i] = (wchar_t)buf[i];
    version[n] = L'\0';
    free(path);
    return 1;
}

/* ---- Where the launcher sits, and what it runs ----------------------------------------------- */

typedef struct {
    int version_local;    /* 1: inside a version folder. 0: stable dispatch through current */
    int command_folder;   /* 1: stable dispatch from the daily install's command folder */
    int separate;         /* 1: <root>\home.marker is a file: a TTASKS_HOME install */
    wchar_t *self;        /* the launcher's own path, long form */
    wchar_t *root;        /* the install root */
    wchar_t *version_dir; /* version-local mode only: the version folder the launcher sits in */
} Place;

typedef struct {
    wchar_t *node;  /* <version folder>\runtime\node.exe */
    wchar_t *entry; /* <version folder>\lib\ttasks.mjs */
} Target;

/* The program's folder below the daily install's share folder (A2 3.2.1). */
#define PRODUCT_FOLDER L"ttasks"

/* Whether folder\home.marker is a file: the folder is a TTASKS_HOME install's root. */
static int has_marker(const wchar_t *folder) {
    wchar_t *marker = join(folder, L"home.marker");
    int found = path_kind(marker) == KIND_FILE;
    free(marker);
    return found;
}

/*
 * Finds the mode and the root from the launcher's own location (A2 3.12.3 step 1). P is the parent
 * of the launcher's folder.
 *   - Version-local: P's parent is named "versions" and P\manifest.json is a file, so P is the
 *     version folder and the root is the parent of "versions".
 *   - Stable dispatch in a TTASKS_HOME install: P\home.marker is a file, so the root is P, which
 *     holds bin\, versions\, current and the data folders together.
 *   - Stable dispatch in the daily install otherwise: the launcher sits in the command folder
 *     (%USERPROFILE%\.local\bin) and the root is P\share\ttasks (%USERPROFILE%\.local\share\ttasks).
 *     resolve() requires share and share\ttasks to be plain folders, as versions below them, so
 *     no link can point the command folder at another install.
 */
static int locate(Place *place) {
    wchar_t *raw = new_path();
    wchar_t *p;
    wchar_t *parent;
    DWORD n = GetModuleFileNameW(NULL, raw, PATH_CAP);
    ZeroMemory(place, sizeof *place);
    if (n == 0 || n >= PATH_CAP) {
        say(L"ttasks: cannot find the launcher's own path\n");
        return 0;
    }
    /* The long form, so TTASKS_ROOT, TTASKS_LAUNCHER and Node's path never carry 8.3 names. */
    place->self = new_path();
    n = GetLongPathNameW(raw, place->self, PATH_CAP);
    if (n == 0 || n >= PATH_CAP) wcscpy_s(place->self, PATH_CAP, raw);
    free(raw);

    p = copy_path(place->self);
    if (!cut_last(p) || !cut_last(p)) {
        say(L"ttasks: unexpected launcher location %s\n", place->self);
        return 0;
    }
    parent = copy_path(p);
    if (cut_last(parent) && _wcsicmp(last_name(parent), L"versions") == 0) {
        wchar_t *manifest = join(p, L"manifest.json");
        int is_version = path_kind(manifest) == KIND_FILE;
        free(manifest);
        if (is_version && cut_last(parent)) {
            place->version_local = 1;
            place->version_dir = p;
            place->root = parent;
            place->separate = has_marker(parent);
            return 1;
        }
    }
    free(parent);
    if (has_marker(p)) {
        place->root = p;
        place->separate = 1;
        return 1;
    }
    {
        wchar_t *share = join(p, L"share");
        place->root = join(share, PRODUCT_FOLDER);
        place->command_folder = 1;
        free(share);
        free(p);
    }
    return 1;
}

static void release_target(Target *t) {
    free(t->node);
    free(t->entry);
    t->node = NULL;
    t->entry = NULL;
}

/*
 * Resolves node.exe and lib\ttasks.mjs (A2 3.12.3 step 2). Stable dispatch reads current on every
 * call, so a restarted service runs the version current names now. Version-local mode never
 * reads current. In both modes versions and the version folder are checked before anything
 * under them, so a launcher started through a junction there runs nothing outside its install.
 * From the daily install's command folder, share and share\ttasks are checked first the same way.
 * Anything missing, or a link below the root, fails with a message naming it.
 */
static int resolve(const Place *place, Target *t) {
    wchar_t *versions;
    wchar_t *version_dir;
    wchar_t *runtime;
    wchar_t *lib;
    int ok;
    ZeroMemory(t, sizeof *t);
    if (place->version_local) {
        version_dir = copy_path(place->version_dir);
    } else {
        wchar_t version[VERSION_MAX + 1];
        wchar_t *folder;
        if (place->command_folder) {
            wchar_t *share = copy_path(place->root);
            cut_last(share);
            ok = require(share, KIND_FOLDER) && require(place->root, KIND_FOLDER);
            free(share);
            if (!ok) return 0;
        }
        if (!read_current(place->root, version, 0)) return 0;
        folder = join(place->root, L"versions");
        version_dir = join(folder, version);
        free(folder);
    }
    versions = copy_path(version_dir);
    cut_last(versions);
    ok = require(versions, KIND_FOLDER) && require(version_dir, KIND_FOLDER);
    free(versions);
    if (!ok) {
        free(version_dir);
        return 0;
    }
    runtime = join(version_dir, L"runtime");
    lib = join(version_dir, L"lib");
    t->node = join(runtime, L"node.exe");
    t->entry = join(lib, L"ttasks.mjs");
    ok = require(runtime, KIND_FOLDER) && require(t->node, KIND_FILE) && require(lib, KIND_FOLDER) &&
         require(t->entry, KIND_FILE);
    free(version_dir);
    free(runtime);
    free(lib);
    if (!ok) release_target(t);
    return ok;
}

/* ---- Sibling repair (A2 3.12.3 step 10) ------------------------------------------------------ */

/* Copies exactly size bytes from in to out: a source that is shorter or longer fails. */
static int copy_bytes(HANDLE in, HANDLE out, LONGLONG size) {
    const DWORD chunk = 64 * 1024;
    char *buffer = (char *)must_alloc(chunk, 1);
    LONGLONG done = 0;
    int ok = 1;
    for (;;) {
        DWORD n = 0, written = 0;
        if (!ReadFile(in, buffer, chunk, &n, NULL)) {
            ok = 0;
            break;
        }
        if (n == 0) break;
        if (done + n > size || !WriteFile(out, buffer, n, &written, NULL) || written != n) {
            ok = 0;
            break;
        }
        done += n;
    }
    free(buffer);
    return ok && done == size;
}

/*
 * Puts a copy of <root>\versions\<version>\bin\<sibling> at sibling (in bin). versions, the
 * version folder, its bin and the file must be plain (no link or junction, as in resolve). The
 * copy goes to a new temporary file in bin, is flushed, and is renamed into place through its own
 * handle without replacing anything: a sibling that appeared meanwhile (an updater's rename,
 * another launcher's repair) is kept and the copy deleted. Returns 1 when sibling is there after.
 */
static int restore_sibling(const wchar_t *root, const wchar_t *version, const wchar_t *bin,
                           const wchar_t *sibling) {
    wchar_t *versions = join(root, L"versions");
    wchar_t *folder = join(versions, version);
    wchar_t *own_bin = join(folder, L"bin");
    wchar_t *source = join(own_bin, SIBLING_LAUNCHER);
    wchar_t *temp = new_path();
    HANDLE in = INVALID_HANDLE_VALUE;
    HANDLE out = INVALID_HANDLE_VALUE;
    LARGE_INTEGER size;
    int ok = path_kind(versions) == KIND_FOLDER && path_kind(folder) == KIND_FOLDER &&
             path_kind(own_bin) == KIND_FOLDER && path_kind(source) == KIND_FILE;
    size.QuadPart = 0;
    if (ok) {
        in = CreateFileW(source, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                         FILE_FLAG_SEQUENTIAL_SCAN, NULL);
        ok = in != INVALID_HANDLE_VALUE && GetFileSizeEx(in, &size) && size.QuadPart > 0 &&
             size.QuadPart <= LAUNCHER_MAX_BYTES;
    }
    if (ok) {
        out = new_temp_file(bin, L"." SIBLING_LAUNCHER, temp);
        ok = out != INVALID_HANDLE_VALUE && copy_bytes(in, out, size.QuadPart) &&
             FlushFileBuffers(out) && rename_open_file(out, sibling, FALSE);
    }
    if (out != INVALID_HANDLE_VALUE) {
        if (!ok) discard_open_file(out);
        CloseHandle(out);
    }
    if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
    if (ok) {
        say(L"ttasks: put %s back from versions\\%s: an update of this install was cut off\n",
            sibling, version);
    } else {
        ok = path_kind(sibling) == KIND_FILE; /* put there by someone else meanwhile */
        if (!ok) say(L"ttasks: %s is missing and could not be put back\n", sibling);
    }
    free(versions);
    free(folder);
    free(own_bin);
    free(source);
    free(temp);
    return ok;
}

/*
 * The data folder, where the service keeps <state> (A2 3.2.1, 3.2.2 rule 1): the
 * root of a TTASKS_HOME install, else %USERPROFILE%\.ttasks, as the service finds it. NULL when
 * USERPROFILE is not a full path (a drive letter and a backslash, or a UNC share).
 */
static wchar_t *data_folder(const Place *place) {
    wchar_t *profile;
    wchar_t *data = NULL;
    DWORD n;
    if (place->separate) return copy_path(place->root);
    profile = new_path();
    n = GetEnvironmentVariableW(L"USERPROFILE", profile, PATH_CAP);
    if (n > 3 && n < PATH_CAP && profile[n - 1] == L'\\') profile[--n] = L'\0';
    if (n >= 3 && n < PATH_CAP &&
        (((profile[0] | 0x20) >= L'a' && (profile[0] | 0x20) <= L'z' && profile[1] == L':' &&
          profile[2] == L'\\') ||
         (profile[0] == L'\\' && profile[1] == L'\\' && profile[2] != L'?' && profile[2] != L'.'))) {
        data = join(profile, L"." PRODUCT_FOLDER);
    }
    free(profile);
    return data;
}

/*
 * Whether an update of this install was cut off: its journal, <state>\update.json (the data
 * folder's state, as the service keeps it), is there, in a plain state folder (A2 3.12.6). Only its
 * existence is read, never its contents.
 */
static int update_journal(const Place *place) {
    wchar_t *data = data_folder(place);
    wchar_t *state;
    wchar_t *journal;
    int found;
    if (data == NULL) return 0;
    state = join(data, L"state");
    journal = join(state, L"update.json");
    found = path_kind(state) == KIND_FOLDER && path_kind(journal) == KIND_FILE;
    free(data);
    free(state);
    free(journal);
    return found;
}

/*
 * Sibling repair (A2 3.12.3 step 10). An update swaps the stable launchers one at a time, and one
 * that runs can only be renamed aside, not replaced (A2 3.12.6), so an update cut off between the
 * two renames of a launcher leaves the command folder without it. Before anything else, a stable
 * launcher in the command folder checks that its sibling is there: one file-attribute call, the
 * only cost on a normal start. When it is missing while an update's journal is there, the launcher
 * puts back the sibling of the version current names, a copy of <root>\versions\<v>\bin\<sibling>:
 * the folder it already runs Node and the bundle from. So the repair reads nothing else (not the
 * journal's contents, no .new or .old-<n> file in the command folder) and can only ever place that
 * version's own launcher, which is the side the update's journal names for it (the swap comes
 * after current changed, and a rollback points current back before it restores the launchers).
 * Node's repair reconciles the rest from the journal (A2 3.12.6). Without a journal nothing is
 * repaired: then no update is under way, and whatever else manages the command folder (install
 * --finish and its undo, an uninstall) is never raced. From the daily install's command folder,
 * share and share\ttasks must be plain folders before current is read, as resolve requires. A repair
 * that cannot be made is reported, and the launcher goes on as it would have: it never changes
 * what it runs.
 */
static void repair_sibling(const Place *place) {
    wchar_t version[VERSION_MAX + 1];
    wchar_t *bin;
    wchar_t *sibling;
    if (place->version_local) return;
    bin = copy_path(place->self);
    if (!cut_last(bin) || _wcsicmp(last_name(bin), L"bin") != 0) {
        free(bin);
        return;
    }
    if (place->command_folder) {
        wchar_t *share = copy_path(place->root);
        int plain = cut_last(share) && path_kind(share) == KIND_FOLDER &&
                    path_kind(place->root) == KIND_FOLDER;
        free(share);
        if (!plain) {
            free(bin);
            return;
        }
    }
    sibling = join(bin, SIBLING_LAUNCHER);
    /* A folder or a link there is not what an install writes: it is left alone. */
    if (path_kind(sibling) == KIND_MISSING && update_journal(place) &&
        read_current(place->root, version, 1)) {
        restore_sibling(place->root, version, bin, sibling);
    }
    free(sibling);
    free(bin);
}

/* ---- Environment (A2 3.12.3 step 3) ---------------------------------------------------------- */

/*
 * The environment rule (A2 3.12.3 step 3). Node reads its NODE_ variables, and OpenSSL its loader
 * settings, while it starts, before the entry runs any code, so only the launcher can keep them
 * out. Removed, in any case and every copy:
 *   - every name that starts with NODE_, except KEEP_NODE. An allow-list within the namespace
 *     also covers the variables a later Node adds.
 *   - OPENSSL_LOADER: what the OpenSSL in Node reads to find a configuration file (which can
 *     load a provider DLL from any path), the folder of included files, providers and engines.
 *   - LAUNCHER_OWNED: the launcher's own variables, which set_environment then sets afresh, and
 *     TTASKS_SERVICE_MANAGER, which only the supervisor sets (to "ttasksw"), so the service's
 *     status names who started it (M1.12).
 * Everything else passes through, including the proxy variables and SSL_CERT_FILE and
 * SSL_CERT_DIR, which select data, not code.
 */
static const wchar_t *const KEEP_NODE[] = {
    L"NODE_EXTRA_CA_CERTS", /* A2 3.12.3: corporate certificates pass through */
};
static const wchar_t *const OPENSSL_LOADER[] = {
    L"OPENSSL_CONF",
    L"OPENSSL_CONF_INCLUDE",
    L"OPENSSL_ENGINES",
    L"OPENSSL_MODULES",
};
static const wchar_t *const LAUNCHER_OWNED[] = {
    L"TTASKS_ROOT",    L"TTASKS_LAUNCHER", L"TTASKS_LAUNCH_MODE",
    L"TTASKS_PACKAGE", L"TTASKS_HOME",     L"TTASKS_SERVICE_MANAGER",
};

/*
 * Names compare as Windows compares them: ordinal, ignoring case by the system's uppercase table,
 * which is what GetEnvironmentVariableW and the C runtime's getenv match by.
 */
static int same_name(const wchar_t *name, int length, const wchar_t *other) {
    return CompareStringOrdinal(name, length, other, -1, TRUE) == CSTR_EQUAL;
}

static int removed_name(const wchar_t *name, int length) {
    int i;
    if (length >= 5 && CompareStringOrdinal(name, 5, L"NODE_", 5, TRUE) == CSTR_EQUAL) {
        for (i = 0; i < (int)_countof(KEEP_NODE); i++) {
            if (same_name(name, length, KEEP_NODE[i])) return 0;
        }
        return 1;
    }
    for (i = 0; i < (int)_countof(OPENSSL_LOADER); i++) {
        if (same_name(name, length, OPENSSL_LOADER[i])) return 1;
    }
    for (i = 0; i < (int)_countof(LAUNCHER_OWNED); i++) {
        if (same_name(name, length, LAUNCHER_OWNED[i])) return 1;
    }
    return 0;
}

/*
 * Finds the first variable the rule removes and copies its name into name (PATH_CAP characters).
 * A name ends at the first '=' after its first character (a leading '=' belongs to the name, as
 * in "=C:"). An entry without '=' is no variable, and no reader sees it. Returns 1 when found, 0
 * when none is left, -1 when the block cannot be read or the name does not fit. Counts the
 * entries into *entries.
 */
static int find_removed(wchar_t *name, size_t *entries) {
    wchar_t *block = GetEnvironmentStringsW();
    const wchar_t *p;
    int found = 0;
    *entries = 0;
    if (block == NULL) return -1;
    for (p = block; *p != L'\0'; p += wcslen(p) + 1) {
        const wchar_t *equals = wcschr(p + 1, L'=');
        (*entries)++;
        if (found == 0 && equals != NULL && removed_name(p, (int)(equals - p))) {
            found = equals - p < PATH_CAP ? 1 : -1;
            if (found == 1) wcsncpy_s(name, PATH_CAP, p, (size_t)(equals - p));
        }
    }
    FreeEnvironmentStringsW(block);
    return found;
}

/*
 * Applies the rule. Each pass removes at least one entry, so the block's first entry count bounds
 * the passes. A variable that cannot be removed stops the launcher (70): Node never starts with it.
 */
static int clean_environment(void) {
    wchar_t *name = new_path();
    size_t limit = 0, entries = 0, pass;
    int found = find_removed(name, &limit);
    for (pass = 0; found == 1 && pass < limit; pass++) {
        if (!SetEnvironmentVariableW(name, NULL)) break;
        found = find_removed(name, &entries);
    }
    if (found == 1) say(L"ttasks: cannot remove %s from the environment\n", name);
    if (found < 0) say(L"ttasks: cannot clean the environment\n");
    free(name);
    return found == 0;
}

/*
 * Sets one of LAUNCHER_OWNED after clean_environment removed every copy, so it ends with exactly
 * this value. NULL leaves it absent.
 */
static int set_variable(const wchar_t *name, const wchar_t *value) {
    if (value == NULL) return 1;
    if (!SetEnvironmentVariableW(name, value)) {
        say(L"ttasks: cannot set %s (error %lu)\n", name, GetLastError());
        return 0;
    }
    return 1;
}

/* The package full name, or NULL outside a package. The caller frees it. */
static wchar_t *package_name(LONG *rc) {
    UINT32 length = 0;
    wchar_t *name;
    *rc = GetCurrentPackageFullName(&length, NULL);
    if (*rc != ERROR_INSUFFICIENT_BUFFER) return NULL;
    name = (wchar_t *)must_alloc((size_t)length + 1, sizeof(wchar_t));
    *rc = GetCurrentPackageFullName(&length, name);
    if (*rc != ERROR_SUCCESS) {
        free(name);
        return NULL;
    }
    return name;
}

/*
 * The environment rule above, and the variables the launcher owns get exactly the values its
 * location gives, whatever the caller set: TTASKS_ROOT, TTASKS_LAUNCHER, TTASKS_LAUNCH_MODE,
 * TTASKS_PACKAGE, and TTASKS_HOME when <root>\home.marker exists (removed otherwise).
 */
static int set_environment(const Place *place) {
    LONG rc;
    /* Any failure here only leaves TTASKS_PACKAGE unset: it informs the entry and guards nothing,
     * unlike --package-info, which the installer relies on and which exits 70 on an error. */
    wchar_t *package = package_name(&rc);
    int ok = clean_environment() && set_variable(L"TTASKS_ROOT", place->root) &&
             set_variable(L"TTASKS_LAUNCHER", place->self) &&
             set_variable(L"TTASKS_LAUNCH_MODE", place->version_local ? L"version" : L"stable") &&
             set_variable(L"TTASKS_PACKAGE", package) &&
             set_variable(L"TTASKS_HOME", place->separate ? place->root : NULL);
    free(package);
    return ok;
}

static int package_info(void) {
    LONG rc;
    wchar_t *name = package_name(&rc);
    if (name != NULL) {
        out(L"%s\n", name);
        free(name);
        return 0;
    }
    if (rc == APPMODEL_ERROR_NO_PACKAGE) {
        out(L"none\n");
        return 0;
    }
    say(L"ttasks: GetCurrentPackageFullName failed (%ld)\n", rc);
    return EXIT_SOFTWARE;
}

/* ---- Starting Node --------------------------------------------------------------------------- */

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

/*
 * Node's command line (A2 3.12.3 step 4): the quoted Node path, the fixed flags, the quoted entry
 * and the tail, copied verbatim. Paths cannot contain a double quote. NULL if it is too long.
 */
static wchar_t *command_line(const Target *t, const wchar_t *tail) {
    wchar_t *cmdline = (wchar_t *)must_alloc(CMDLINE_CAP, sizeof(wchar_t));
    if (_snwprintf_s(cmdline, CMDLINE_CAP, _TRUNCATE, L"\"%s\" --report-exclude-env \"%s\"%s%s",
                     t->node, t->entry, *tail != L'\0' ? L" " : L"", tail) < 0) {
        say(L"ttasks: the command line is too long for Windows\n");
        free(cmdline);
        return NULL;
    }
    return cmdline;
}

/*
 * What Node inherits: the launcher's standard handles and nothing else. Each one is duplicated
 * as an inheritable handle and named in PROC_THREAD_ATTRIBUTE_HANDLE_LIST, so any other
 * inheritable handle the launcher received from its caller stays with the launcher. A standard
 * handle that is missing, or a value that names no file, pipe or console (a closed one), leaves
 * Node without it. The duplicates are closed once Node exists. Never copy a Spawn: the attribute
 * list points at its list array.
 */
typedef struct {
    STARTUPINFOEXW si;
    HANDLE handles[3]; /* the duplicates, or NULL where Node gets none */
    HANDLE list[3];    /* the non-NULL duplicates, in the attribute list */
    DWORD count;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes;
    int initialized;
} Spawn;

static void release_spawn(Spawn *s) {
    int i;
    if (s->initialized) DeleteProcThreadAttributeList(s->attributes);
    free(s->attributes);
    for (i = 0; i < 3; i++) {
        if (s->handles[i] != NULL) CloseHandle(s->handles[i]);
    }
    ZeroMemory(s, sizeof *s);
}

static int duplicate_std(DWORD which, HANDLE *copy) {
    HANDLE h = GetStdHandle(which);
    *copy = NULL;
    if (h == NULL || h == INVALID_HANDLE_VALUE) return 1;
    SetLastError(NO_ERROR);
    if (GetFileType(h) == FILE_TYPE_UNKNOWN && GetLastError() != NO_ERROR) return 1;
    if (!DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), copy, 0, TRUE,
                         DUPLICATE_SAME_ACCESS)) {
        say(L"ttasks: cannot pass a standard handle to Node (error %lu)\n", GetLastError());
        *copy = NULL;
        return 0;
    }
    return 1;
}

/* Prepares s for spawn(). Fails closed: 0 if a handle or the attribute list cannot be made. */
static int prepare_spawn(Spawn *s) {
    static const DWORD which[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    SIZE_T size = 0;
    int i;
    ZeroMemory(s, sizeof *s);
    for (i = 0; i < 3; i++) {
        if (!duplicate_std(which[i], &s->handles[i])) {
            release_spawn(s);
            return 0;
        }
        if (s->handles[i] != NULL) s->list[s->count++] = s->handles[i];
    }
    s->si.StartupInfo.cb = sizeof s->si.StartupInfo;
    s->si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    s->si.StartupInfo.hStdInput = s->handles[0];
    s->si.StartupInfo.hStdOutput = s->handles[1];
    s->si.StartupInfo.hStdError = s->handles[2];
    if (s->count == 0) return 1; /* nothing to inherit: CreateProcessW inherits nothing */
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    s->attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)must_alloc(1, size);
    s->initialized = InitializeProcThreadAttributeList(s->attributes, 1, 0, &size);
    if (!s->initialized ||
        !UpdateProcThreadAttribute(s->attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, s->list,
                                   s->count * sizeof(HANDLE), NULL, NULL)) {
        say(L"ttasks: cannot limit the handles Node inherits (error %lu)\n", GetLastError());
        release_spawn(s);
        return 0;
    }
    s->si.StartupInfo.cb = sizeof s->si;
    s->si.lpAttributeList = s->attributes;
    return 1;
}

/* CreateProcessW for Node with the handles s allows. */
static BOOL spawn(Spawn *s, const Target *t, wchar_t *cmdline, DWORD flags,
                  PROCESS_INFORMATION *pi) {
    if (s->count > 0) flags |= EXTENDED_STARTUPINFO_PRESENT;
    return CreateProcessW(t->node, cmdline, NULL, NULL, s->count > 0, flags, NULL, NULL,
                          &s->si.StartupInfo, pi);
}

#ifndef TTASKS_GUI
/*
 * Ctrl+C and Ctrl+Break go to the whole console group, so Node receives them too and decides.
 * The launcher only stays alive to report Node's exit code. A handler function is used instead
 * of SetConsoleCtrlHandler(NULL, TRUE), because that flag is inherited by Node (A2 3.12.3 step 5).
 */
static BOOL WINAPI ignore_ctrl(DWORD type) {
    return type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT;
}

#ifdef TTASKS_TEST_HOOKS
/*
 * Test builds only: TTASKS_TEST_JOB_FAIL names one step of the job setup (create, limits, assign,
 * resume) that then fails as if Windows had refused it.
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
 * The job Node runs in: it closes with this launcher, so an agent app that kills the bridge it
 * started also kills Node. Silent breakaway keeps Node's own children out of the job: Node
 * manages them, and a detached run must outlive the CLI call that started it. Returns NULL and
 * names the refused call in *step.
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
        DWORD error = GetLastError();
        CloseHandle(job);
        SetLastError(error); /* the caller reports the refused call's error */
        *step = L"SetInformationJobObject";
        return NULL;
    }
    return job;
}

/*
 * ttasks.exe (A2 3.12.3 step 5): Node runs only inside the job. The job is ready
 * before Node exists, and Node starts suspended, so a refusal at any step stops it before it runs
 * any code. Returns Node's exit code, or 70.
 */
static int run_in_job(const Target *t, const wchar_t *tail) {
    const wchar_t *step = NULL;
    Spawn spawned;
    PROCESS_INFORMATION pi;
    DWORD flags = CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    DWORD code = EXIT_SOFTWARE;
    BOOL started;
    wchar_t *cmdline;
    /* Never closed: closing a kill-on-close job ends Node. It closes when the launcher exits. */
    HANDLE job = new_job(&step);
    if (job == NULL) {
        say(L"ttasks: cannot create the job object for Node (%s, error %lu). Node did not start.\n",
            step, GetLastError());
        return EXIT_SOFTWARE;
    }
    cmdline = command_line(t, tail);
    if (cmdline == NULL) return EXIT_SOFTWARE;
    if (!prepare_spawn(&spawned)) {
        free(cmdline);
        return EXIT_SOFTWARE;
    }
    ZeroMemory(&pi, sizeof pi);
    /* Without any console (a detached start), keep Node from opening a console window. */
    if (GetConsoleCP() == 0) flags |= CREATE_NO_WINDOW;
    SetConsoleCtrlHandler(ignore_ctrl, TRUE);
    started = spawn(&spawned, t, cmdline, flags, &pi);
    if (!started) say(L"ttasks: cannot start %s (error %lu)\n", t->node, GetLastError());
    release_spawn(&spawned);
    free(cmdline);
    if (!started) return EXIT_SOFTWARE;
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
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    if (!GetExitCodeProcess(pi.hProcess, &code)) code = EXIT_SOFTWARE;
    CloseHandle(pi.hProcess);
    return (int)code;
}
#endif /* !TTASKS_GUI */

#ifdef TTASKS_GUI
/*
 * ttasksw.exe (A2 3.12.3 step 6): Node without a window and outside any job, so processes the
 * service starts detached outlive both. Returns 0 if Node could not start, else 1 with its exit
 * code in *code.
 */
static int run_hidden(const Target *t, const wchar_t *tail, DWORD *code) {
    Spawn spawned;
    PROCESS_INFORMATION pi;
    BOOL started;
    wchar_t *cmdline = command_line(t, tail);
    if (cmdline == NULL) return 0;
    if (!prepare_spawn(&spawned)) {
        free(cmdline);
        return 0;
    }
    ZeroMemory(&pi, sizeof pi);
    started = spawn(&spawned, t, cmdline, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, &pi);
    if (!started) say(L"ttasks: cannot start %s (error %lu)\n", t->node, GetLastError());
    release_spawn(&spawned);
    free(cmdline);
    if (!started) return 0;
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    if (!GetExitCodeProcess(pi.hProcess, code)) *code = EXIT_SOFTWARE;
    CloseHandle(pi.hProcess);
    return 1;
}

/* ---- The supervisor (A2 3.3.2) --------------------------------------------------------------- */

#ifdef TTASKS_TEST_HOOKS
/* Test builds only: TTASKS_TEST_TIME_UNIT_MS (1 to 60000) replaces the one-second time unit. */
static DWORD time_unit_ms(void) {
    wchar_t value[16];
    wchar_t *end = NULL;
    unsigned long ms;
    DWORD n = GetEnvironmentVariableW(L"TTASKS_TEST_TIME_UNIT_MS", value, _countof(value));
    if (n == 0 || n >= _countof(value)) return TIME_UNIT_MS;
    ms = wcstoul(value, &end, 10);
    return (end != value && *end == L'\0' && ms >= 1 && ms <= 60000) ? (DWORD)ms : TIME_UNIT_MS;
}

/* Test builds only: appends one line per supervisor decision to the file TTASKS_TEST_TRACE names. */
static void trace(const wchar_t *fmt, ...) {
    wchar_t *path = new_path();
    wchar_t line[256];
    char utf8[1024];
    DWORD n = GetEnvironmentVariableW(L"TTASKS_TEST_TRACE", path, PATH_CAP);
    va_list ap;
    if (n > 0 && n < PATH_CAP) {
        HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL, OPEN_ALWAYS,
                               FILE_ATTRIBUTE_NORMAL, NULL);
        if (h != INVALID_HANDLE_VALUE) {
            DWORD written = 0;
            int bytes;
            va_start(ap, fmt);
            _vsnwprintf_s(line, _countof(line), _TRUNCATE, fmt, ap);
            va_end(ap);
            wcscat_s(line, _countof(line), L"\n");
            bytes = WideCharToMultiByte(CP_UTF8, 0, line, -1, utf8, (int)sizeof utf8, NULL, NULL);
            if (bytes > 1) WriteFile(h, utf8, (DWORD)(bytes - 1), &written, NULL);
            CloseHandle(h);
        }
    }
    free(path);
}
#else
static DWORD time_unit_ms(void) {
    return TIME_UNIT_MS;
}
#define trace(...) ((void)0)
#endif

typedef struct {
    ULONGLONG tick;  /* GetTickCount64 when the failure was seen */
    SYSTEMTIME wall; /* the same moment in UTC, for the give-up record */
    int started;     /* 0: Node could not be started at all */
    DWORD code;      /* Node's exit code when started */
} Failure;

static int is_recent(ULONGLONG tick, ULONGLONG now, ULONGLONG window) {
    return now - tick < window;
}

static void iso_time(const SYSTEMTIME *t, char *buf, size_t cap) {
    _snprintf_s(buf, cap, _TRUNCATE, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", t->wYear, t->wMonth,
                t->wDay, t->wHour, t->wMinute, t->wSecond, t->wMilliseconds);
}

/* A plain folder below the root, made if it is missing. A link there is refused, as in resolve. */
static int plain_folder(const wchar_t *path) {
    if (path_kind(path) == KIND_MISSING) CreateDirectoryW(path, NULL);
    return require(path, KIND_FOLDER);
}

/*
 * Writes <state>\crash\supervisor-gave-up.json (A2 3.3.2, 3.13), <state> being the data folder's
 * state: the time, the window and each failure of the window, oldest first. No paths and no
 * environment. state and crash must be plain folders, so no link redirects the record elsewhere.
 * The record is written to a new temporary file, flushed, and that same file is renamed over the
 * old record through its handle: an existing file is never opened for writing, so a hard link
 * planted at either name cannot carry the write to another file. On any failure the temporary
 * file is deleted.
 */
static void write_give_up(const Place *place, const Failure *ring, int count, int next,
                          ULONGLONG window_ms) {
    char json[2048];
    char when[32];
    size_t len = 0;
    int i;
    SYSTEMTIME now;
    wchar_t *data = data_folder(place);
    wchar_t *state;
    wchar_t *crash;
    wchar_t *file;
    wchar_t *temp;
    HANDLE h = INVALID_HANDLE_VALUE;
    DWORD written = 0;
    BOOL ok;

    if (data == NULL) {
        say(L"ttasks: USERPROFILE names no folder, so the supervisor's give-up record is not "
            L"written\n");
        return;
    }
    /* A service that never started has not made the data folder yet. Like the root, the data
     * folder itself may be a link (a moved profile); state and crash below it may not. */
    if (path_kind(data) == KIND_MISSING) CreateDirectoryW(data, NULL);
    state = join(data, L"state");
    crash = join(state, L"crash");
    file = join(crash, L"supervisor-gave-up.json");
    temp = new_path();
    free(data);

    GetSystemTime(&now);
    iso_time(&now, when, sizeof when);
    _snprintf_s(json, sizeof json, _TRUNCATE,
                "{\"format\":1,\"event\":\"supervisor.gave_up\",\"t\":\"%s\",\"window_ms\":%llu,"
                "\"failures\":[",
                when, window_ms);
    for (i = 0; i < count; i++) {
        const Failure *f = &ring[(next - count + i + GIVE_UP_FAILURES) % GIVE_UP_FAILURES];
        len = strlen(json);
        iso_time(&f->wall, when, sizeof when);
        if (f->started) {
            _snprintf_s(json + len, sizeof json - len, _TRUNCATE, "%s{\"t\":\"%s\",\"exit\":%lu}",
                        i > 0 ? "," : "", when, f->code);
        } else {
            _snprintf_s(json + len, sizeof json - len, _TRUNCATE,
                        "%s{\"t\":\"%s\",\"exit\":null,\"start\":\"failed\"}", i > 0 ? "," : "",
                        when);
        }
    }
    len = strlen(json);
    _snprintf_s(json + len, sizeof json - len, _TRUNCATE, "]}\n");

    ok = plain_folder(state) && plain_folder(crash);
    if (ok) {
        h = new_temp_file(crash, L"supervisor-gave-up", temp);
        ok = h != INVALID_HANDLE_VALUE &&
             WriteFile(h, json, (DWORD)strlen(json), &written, NULL) && FlushFileBuffers(h) &&
             rename_open_file(h, file, TRUE);
        if (!ok) say(L"ttasks: cannot write %s (error %lu)\n", file, GetLastError());
    }
    if (h != INVALID_HANDLE_VALUE) {
        if (!ok) discard_open_file(h);
        CloseHandle(h);
    }
    free(state);
    free(crash);
    free(file);
    free(temp);
}

/*
 * A file's identity: its volume's serial number and its index there. Every name of one file shares
 * it; a new file put at a name has another.
 */
typedef struct {
    DWORD volume;
    DWORD high;
    DWORD low;
    int known;
} FileId;

static FileId file_id(const wchar_t *path) {
    FileId id;
    BY_HANDLE_FILE_INFORMATION info;
    HANDLE h = CreateFileW(path, FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                           OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    ZeroMemory(&id, sizeof id);
    if (h == INVALID_HANDLE_VALUE) return id;
    if (GetFileInformationByHandle(h, &info)) {
        id.volume = info.dwVolumeSerialNumber;
        id.high = info.nFileIndexHigh;
        id.low = info.nFileIndexLow;
        id.known = 1;
    }
    CloseHandle(h);
    return id;
}

/*
 * Whether the command folder's ttasksw.exe is now another plain file than the one this supervisor
 * started from: an update, or the service's repair of an interrupted one, put a new supervisor
 * there while this one ran from the old file, which Windows let it rename aside (A2 3.12.6).
 */
static int supervisor_replaced(const Place *place, const FileId *own) {
    FileId now;
    if (!own->known || path_kind(place->self) != KIND_FILE) return 0;
    now = file_id(place->self);
    return now.known && (now.volume != own->volume || now.high != own->high || now.low != own->low);
}

/*
 * Starts the supervisor that is now at the command folder's ttasksw.exe, with no arguments and no
 * inherited handle, to supervise in this one's place. It cleans the environment and finds its install by
 * its own location, as every launcher does. Returns 0 when it could not be started: this one then
 * goes on supervising.
 */
static int hand_over(const Place *place) {
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    wchar_t *cmdline = (wchar_t *)must_alloc(CMDLINE_CAP, sizeof(wchar_t));
    BOOL started = FALSE;
    ZeroMemory(&si, sizeof si);
    ZeroMemory(&pi, sizeof pi);
    si.cb = sizeof si;
    if (_snwprintf_s(cmdline, CMDLINE_CAP, _TRUNCATE, L"\"%s\"", place->self) >= 0) {
        started = CreateProcessW(place->self, cmdline, NULL, NULL, FALSE,
                                 CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &si, &pi);
    }
    free(cmdline);
    if (!started) {
        say(L"ttasksw: cannot start the new supervisor %s (error %lu)\n", place->self,
            GetLastError());
        return 0;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 1;
}

/*
 * Before each start of the service but the first: when bin\ttasksw.exe is another file than the one
 * this supervisor runs from, starts that one in its place. Every restart checks, whatever ended the
 * service, so a service that dies after its repair replaced the supervisor, before it could ask
 * for the restart (exit 75), still leaves the service to the new one. Returns 1 when it handed
 * over: this one then exits 0.
 */
static int handed_over(const Place *place, const FileId *own) {
    if (!supervisor_replaced(place, own)) return 0;
    if (hand_over(place)) {
        trace(L"hand-over");
        return 1;
    }
    trace(L"hand-over-failed");
    return 0;
}

/*
 * ttasksw.exe with no arguments (A2 3.3.1, 3.3.2): starts `ttasks serve` from the version current
 * names, waits, and applies the exit-code table.
 *   0, 64, 73  stop, and exit with that code
 *   75         start again at once, re-reading current (more than QUICK_RESTART_LIMIT of these
 *              within the window count as failures)
 *   other      a failure, as is a start that fails: restart after 1, 2, 4 and 8 units. The
 *              GIVE_UP_FAILURES-th failure within the window writes the give-up record and the
 *              supervisor exits 70
 * Before any restart, when bin\ttasksw.exe is no longer the file this supervisor runs from (an
 * update or a repair replaced it), the new one is started in its place, and this one exits 0
 * (handed_over).
 */
static int supervise(const Place *place) {
    Failure failures[GIVE_UP_FAILURES];
    ULONGLONG quick[QUICK_RESTART_LIMIT];
    int failure_count = 0, failure_next = 0, quick_next = 0;
    const ULONGLONG unit = time_unit_ms();
    const ULONGLONG window = (ULONGLONG)FAILURE_WINDOW_UNITS * unit;
    /* The file this supervisor runs from, while it is still at its name. */
    const FileId own = file_id(place->self);
    int i;
    ZeroMemory(failures, sizeof failures);
    ZeroMemory(quick, sizeof quick);
    /* The service records its manager in service.json and its status (A2 3.2.3). */
    if (!set_variable(L"TTASKS_SERVICE_MANAGER", L"ttasksw")) return EXIT_SOFTWARE;
    for (;;) {
        Target target;
        DWORD code = EXIT_SOFTWARE;
        int started = 0;
        int recent = 0;
        ULONGLONG now;
        if (resolve(place, &target)) {
            started = run_hidden(&target, L"serve", &code);
            release_target(&target);
        }
        now = GetTickCount64();
        if (started) {
            trace(L"exit %lu", code);
            if (code == 0 || code == EXIT_USAGE || code == EXIT_LOCKED) {
                trace(L"stop %lu", code);
                return (int)code;
            }
            if (code == EXIT_RESTART) {
                int quick_recent = 0;
                /* The service restarts after an update: a replaced supervisor hands over. */
                if (handed_over(place, &own)) return 0;
                for (i = 0; i < QUICK_RESTART_LIMIT; i++) {
                    if (quick[i] != 0 && is_recent(quick[i], now, window)) quick_recent++;
                }
                if (quick_recent < QUICK_RESTART_LIMIT) {
                    quick[quick_next] = now;
                    quick_next = (quick_next + 1) % QUICK_RESTART_LIMIT;
                    trace(L"restart");
                    continue;
                }
            }
        } else {
            trace(L"start-failed");
        }
        failures[failure_next].tick = now;
        GetSystemTime(&failures[failure_next].wall);
        failures[failure_next].started = started;
        failures[failure_next].code = code;
        failure_next = (failure_next + 1) % GIVE_UP_FAILURES;
        if (failure_count < GIVE_UP_FAILURES) failure_count++;
        for (i = 0; i < failure_count; i++) {
            if (is_recent(failures[i].tick, now, window)) recent++;
        }
        if (recent >= GIVE_UP_FAILURES) {
            write_give_up(place, failures, failure_count, failure_next, window);
            trace(L"gave-up");
            return EXIT_SOFTWARE;
        }
        trace(L"wait %lu", RESTART_DELAY_UNITS[recent - 1]);
        Sleep((DWORD)(RESTART_DELAY_UNITS[recent - 1] * unit));
        if (handed_over(place, &own)) return 0;
    }
}
#endif /* TTASKS_GUI */

/* ---- Entry ----------------------------------------------------------------------------------- */

int wmain(int argc, wchar_t **argv) {
    Place place;
    Target target;
    int code;

    /* --package-info answers before anything is read, so an installer can ask a candidate first. */
    if (argc >= 2 && wcscmp(argv[1], L"--package-info") == 0) {
        if (argc != 2) {
            say(L"usage: ttasks --package-info\n");
            return EXIT_USAGE;
        }
        return package_info();
    }
    if (!locate(&place)) return EXIT_SOFTWARE;
    /* Before anything runs: a sibling an interrupted update left missing is put back. */
    repair_sibling(&place);
    if (!set_environment(&place)) return EXIT_SOFTWARE;

#ifdef TTASKS_GUI
    if (argc < 2) {
        /* A supervisor inside a version folder would pin the service to that version forever. */
        if (place.version_local) {
            say(L"ttasksw: supervises only from the bin folder of an install, not from a version "
                L"folder\n");
            return EXIT_USAGE;
        }
        return supervise(&place);
    }
#endif

    if (!resolve(&place, &target)) return EXIT_SOFTWARE;
#ifdef TTASKS_GUI
    {
        DWORD exit_code = EXIT_SOFTWARE;
        code = run_hidden(&target, command_tail(GetCommandLineW()), &exit_code)
                   ? (int)exit_code
                   : EXIT_SOFTWARE;
    }
#else
    code = run_in_job(&target, command_tail(GetCommandLineW()));
#endif
    release_target(&target);
    return code;
}
