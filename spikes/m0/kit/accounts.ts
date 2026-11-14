// Row S12: the doctor's other-accounts check (A2 M0-S15). Lists the machine's other interactive
// user accounts: Linux accounts with a UID from 1000 and a login shell, Windows enabled local
// accounts. The current user is left out. The lab shows the result to the maintainer and records only
// whether the list is empty.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export function otherAccounts(): string[] {
  const me = userInfo().username.toLowerCase();
  let names: string[] = [];
  if (process.platform === "win32") {
    const ps = join(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = spawnSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object { $_.Name }",
      ],
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Get-LocalUser failed");
    names = result.stdout.split(/\r?\n/).map((n) => n.trim());
  } else {
    for (const row of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const [name, , uid, , , , shell] = row.split(":");
      const id = Number(uid);
      if (name === undefined || shell === undefined || !Number.isInteger(id)) continue;
      if (id < 1000 || id === 65534 || /(nologin|false)$/.test(shell)) continue;
      names.push(name);
    }
  }
  return names.filter((n) => n !== "" && n.toLowerCase() !== me);
}
