// Where the service runs in the cgroup tree, read from /proc/self/cgroup. Pure, so every answer
// can be tested on any machine.
import { CLI_NAME, PRODUCT_ID } from "@ttasks/brand";
import type { UnavailableReason } from "./types.ts";

/** The file name of the Windows helper that holds a run's job object. */
export const RUN_HELPER = `${PRODUCT_ID}-run.exe`;

/** The child cgroup the service moves itself into, so the unit's own cgroup holds no process. */
export const MAIN_CGROUP = "main";

export type Placement =
  | {
      readonly ok: true;
      /** The unit's name, for example `ttasks.service`. */
      readonly unit: string;
      /** The unit's cgroup, relative to the cgroup2 mount, starting with `/`. */
      readonly root: string;
      /** Whether the process already sits in the unit's `main` child. */
      readonly inMain: boolean;
    }
  | { readonly ok: false; readonly reason: UnavailableReason };

const SERVICE = /\.service$/;

/**
 * Reads `/proc/self/cgroup`. Runs can be grouped only when it has the unified hierarchy alone
 * (one line `0::<path>`) and the path is a `.service` unit of this user's systemd manager
 * (`…/user@<uid>.service/…/<unit>.service`, or its `main` child).
 */
export function placement(selfCgroup: string, uid: number): Placement {
  const lines = selfCgroup.split("\n").filter((line) => line !== "");
  const unified = lines.filter((line) => line.startsWith("0::"));
  if (unified.length !== 1 || lines.length !== 1) return { ok: false, reason: "no_cgroup_v2" };
  const path = (unified[0] ?? "").slice(3);
  if (!path.startsWith("/")) return { ok: false, reason: "no_cgroup_v2" };
  const parts = path.split("/").filter((part) => part !== "");
  const inMain = parts.at(-1) === MAIN_CGROUP;
  const unitParts = inMain ? parts.slice(0, -1) : parts;
  const manager = unitParts.indexOf(`user@${String(uid)}.service`);
  if (manager === -1) return { ok: false, reason: "no_user_manager" };
  const unit = unitParts.at(-1) ?? "";
  if (unitParts.length - 1 === manager || !SERVICE.test(unit)) {
    return { ok: false, reason: "not_a_service" };
  }
  return { ok: true, unit, root: `/${unitParts.join("/")}`, inMain };
}

/** The message a person reads for each reason Run is not available. */
export function unavailableMessage(reason: UnavailableReason, detail?: string): string {
  switch (reason) {
    case "unsupported_platform":
      return "Background runs are not available on this operating system yet.";
    case "no_systemd":
      return "Background runs need systemd, which is not running here (WSL without systemd, or a container).";
    case "no_cgroup_v2":
      return "Background runs need the unified cgroup hierarchy (cgroup v2), which this system does not use.";
    case "no_user_manager":
      return `Background runs need the service to run under your systemd user manager. Install it with \`${CLI_NAME} service install\`.`;
    case "not_a_service":
      return `Background runs need the service to run as your systemd user service, not started by hand. Install it with \`${CLI_NAME} service install\`.`;
    case "not_delegated":
      return `The service's systemd unit does not let it manage its own processes (Delegate=yes). Run \`${CLI_NAME} service install\` again, then restart the service.`;
    case "no_cgroup_kill":
      return "Background runs need Linux 5.14 or later, which can end a whole group of processes at once.";
    case "helper_missing":
      return `The program that holds background runs (${RUN_HELPER}) is missing from this installation. Reinstall to restore it.`;
    case "check_failed":
      return `Background runs could not be given their own process group on this machine${detail === undefined ? "" : ` (${detail})`}.`;
  }
}
