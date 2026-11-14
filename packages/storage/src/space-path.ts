// The path rules for a space folder (A1 3.1). A space folder is `<spaces root>/<slug>/` (A1 3.1).
//
// - The path is absolute. It is resolved, so `.` and `..` segments go.
// - The folder name is the space's slug: 1 to 64 characters from a-z, 0-9 and `-`, starting and
//   ending with a letter or digit, and not a Windows device name (`con`, `nul`, `com1` …), so the
//   same folder name works on every OS a space can move to.
// - On Windows, every component of the path, the server and share of a UNC path included: no
//   `<>:"/\|?*` or control characters, no trailing dot or space (Windows silently drops them, so
//   `mira.` would open `mira`), and no device name. Every file name a driver hands SQLite meets the
//   same rule (sqlite-uri.ts). The device names are Microsoft's list in
//   "Naming Files, Paths, and Namespaces" (checked 2026-11-12): CON, PRN, AUX, NUL, COM1 to COM9,
//   LPT1 to LPT9, and COM and LPT with the superscript digits ¹, ² and ³, in any case. A name is
//   one of them when the part before its FIRST dot is, with trailing spaces ignored, so
//   `nul.tar.gz` and `con .txt` are devices. COM0 and LPT0 are not on the list. Windows 11 creates
//   such folders in a subfolder, older Windows and other tools do not, so they are refused anyway.
//   Device namespace paths (`\\?\`, `\\.\`) are refused: the driver adds `\\?\` itself where a
//   path needs it (A1 3.19). UNC paths pass here. A1 3.2's network check refuses to write
//   to them when it arrives.
// - On Linux and macOS, components may hold anything but NUL, as the OS allows. The parent folder
//   is machine-local, so only the slug has to travel.
import { posix, win32 } from "node:path";
import { StorageError } from "./errors.ts";

/** The longest slug. */
export const SLUG_MAX = 64;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const WINDOWS_BAD_CHAR = /[<>:"/\\|?*\u0000-\u001f]/;

/** Whether Windows reads the name as a device: the part before the first dot, less trailing spaces. */
export function isWindowsDeviceName(name: string): boolean {
  const stem = name.split(".", 1)[0] ?? "";
  return DEVICE_NAME.test(stem.replace(/ +$/, ""));
}

const invalid = (reason: string): StorageError =>
  new StorageError("SPACE_PATH_INVALID", `The space path is not valid: ${reason}`);

/** Whether `value` is a valid space slug: the folder name of a space. */
export function isSpaceSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= SLUG_MAX &&
    SLUG.test(value) &&
    !isWindowsDeviceName(value)
  );
}

/**
 * A slug for a space name: its ASCII letters and digits in lower case, accents removed, every
 * other run of characters as one `-`. "Mira" gives `mira`, "Ålborg Kontor" gives `alborg-kontor`.
 * A name with no letter or digit gives `space`, and a Windows device name gets `-space` added.
 */
export function slugFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  if (base === "") return "space";
  return isWindowsDeviceName(base) ? `${base.slice(0, SLUG_MAX - 6)}-space` : base;
}

/**
 * Why Windows would not keep `component`, one part of a path, as written, or undefined when it
 * would. The same rule guards every file name a driver hands SQLite (sqlite-uri.ts).
 */
export function windowsComponentProblem(component: string): string | undefined {
  if (component === "") return "an empty path component";
  if (WINDOWS_BAD_CHAR.test(component)) return "a character Windows does not allow";
  if (/[. ]$/.test(component)) return "a component that ends with a dot or a space";
  if (isWindowsDeviceName(component)) return "a Windows device name";
  return undefined;
}

function checkWindowsComponent(component: string): void {
  const problem = windowsComponentProblem(component);
  if (problem !== undefined) throw invalid(problem);
}

/**
 * Checks a space folder path on `platform` and returns it resolved. Throws SPACE_PATH_INVALID,
 * whose message names the rule and never the path.
 */
export function checkSpacePath(
  path: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof path !== "string" || path.length === 0) throw invalid("not a path");
  if (path.includes("\0")) throw invalid("a NUL character");
  const windows = platform === "win32";
  const p = windows ? win32 : posix;
  if (windows && /^[\\/]{2}[?.][\\/]/.test(path)) throw invalid("a device namespace path");
  if (!p.isAbsolute(path)) throw invalid("not absolute");
  // A drive-relative path such as \mira or C:mira is not absolute enough: it depends on the
  // current drive or folder.
  if (windows && !/^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path)) throw invalid("no drive or share");
  const resolved = p.resolve(path);
  const { root, base } = p.parse(resolved);
  if (!isSpaceSlug(base)) throw invalid("the folder name is not a space slug");
  if (windows) {
    // A UNC root is \\server\share\: its server and share are components like any other.
    const unc = /^\\\\([^\\]*)\\([^\\]*)\\?$/.exec(root);
    if (unc !== null) {
      checkWindowsComponent(unc[1] ?? "");
      checkWindowsComponent(unc[2] ?? "");
    }
    const rest = resolved.slice(root.length);
    for (const component of rest.split("\\")) checkWindowsComponent(component);
  }
  return resolved;
}
