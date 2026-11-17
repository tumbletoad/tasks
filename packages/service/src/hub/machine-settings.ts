// This machine's settings as the page reads and changes them: the theme and the single-letter keys
// (machine preferences in machine.toml's `[preferences]`), and the terminal Open uses (`[terminal]
// app`). They are the person's on this machine, the same in every space and tab, and only the
// person changes them: the page's grant is the person, and no agent tool reaches this module.
//
// Every change is one splice of machine.toml that keeps the rest of the file (config/edit.ts), and
// applies at once: the service holds what it read at start and each value it wrote since, and tells
// every open tab (the feed's `machine` message).
import { AppError, preferenceSpec, type PreferenceRead, type PrefValue } from "@tasks/contracts";
import { TERMINAL_APPS, type TerminalSettings } from "@tasks/launch";
import { commitEdit, prepareEditOf, type Edit, type EditRefusal } from "../config/edit.ts";
import { parseMachineConfig } from "../config/machine-toml.ts";
import { setMachinePreference } from "../config/preferences.ts";
import type { TerminalView } from "../launch/index.ts";
import type { Logger } from "./log.ts";

/** The machine preferences the page shows and sets. */
export const PAGE_PREFERENCES = ["ui.theme", "ui.single_keys"] as const;
type PageKey = (typeof PAGE_PREFERENCES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPageKey = (key: unknown): key is PageKey =>
  typeof key === "string" && (PAGE_PREFERENCES as readonly string[]).includes(key);

/** The launch service's terminal, as Settings reads and changes it. */
export interface TerminalPort {
  view(): Promise<TerminalView | null>;
  settings(): TerminalSettings;
  apply(next: TerminalSettings): void;
}

export interface MachineSettingsOptions {
  /** The folder of machine.toml. */
  readonly configDir: string;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
  /** machine.toml's `[preferences]` at start. */
  readonly preferences: ReadonlyMap<string, PrefValue>;
  /** None: this service opens no terminal, and Settings shows no choice of one. */
  readonly terminal?: TerminalPort;
}

function refused(reason: EditRefusal): AppError {
  switch (reason) {
    case "changed_meanwhile":
      return new AppError({
        code: "conflict",
        message: "machine.toml changed while the setting was being saved.",
        hint: "Try again.",
      });
    case "invalid_value":
      return new AppError({
        code: "invalid_input",
        message: "This setting does not take that value.",
        data: { issues: [{ path: "value", message: "Not a value of this setting" }] },
      });
    case "invalid_file":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml cannot be read as it is, so nothing was changed.",
        hint: "Run tasks doctor, then fix machine.toml.",
      });
    case "unsupported_layout":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml writes this setting in a way Settings cannot change.",
        hint: "Change it in machine.toml by hand.",
      });
    default:
      return new AppError({
        code: "invalid_input",
        message: "The setting cannot be written to machine.toml.",
        hint: "Run tasks doctor.",
      });
  }
}

const notASetting = (): AppError =>
  new AppError({
    code: "invalid_input",
    message: "Settings has no such setting.",
    data: { issues: [{ path: "key", message: "Not a setting of this machine" }] },
  });

export class MachineSettings {
  readonly #o: MachineSettingsOptions;
  readonly #values: Map<string, PrefValue>;
  readonly #listeners = new Set<() => void>();
  /** Changes run one at a time, each against the file the one before it wrote. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: MachineSettingsOptions) {
    this.#o = options;
    this.#values = new Map(options.preferences);
  }

  /** The page's machine preferences: each set value, else its default. */
  preferences(): PreferenceRead[] {
    return PAGE_PREFERENCES.map((key) => {
      const value = this.#values.get(key);
      const spec = preferenceSpec(key);
      return value === undefined
        ? { key, value: spec?.default ?? null, state: "default" }
        : { key, value, state: "set" };
    });
  }

  /** The theme the page paints first. */
  theme(): string {
    const value = this.#values.get("ui.theme");
    return typeof value === "string" ? value : "sumi";
  }

  /** Calls `listener` after each change. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  #run<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Sets one of the page's machine preferences, or resets it to its default with null. */
  setPreference(key: unknown, value: unknown): Promise<PreferenceRead> {
    if (!isPageKey(key)) return Promise.reject(notASetting());
    return this.#run(() => {
      const edited = setMachinePreference(
        this.#o.configDir,
        key,
        value as PrefValue | null,
        this.#o.platform,
      );
      if (!edited.ok) throw refused(edited.reason);
      if (value === null) this.#values.delete(key);
      else this.#values.set(key, value as PrefValue);
      this.#o.log.log("config.preference_set", { key, reset: value === null });
      this.#changed();
      const read = this.preferences().find((p) => p.key === key);
      if (read === undefined) throw notASetting();
      return read;
    });
  }

  /** Open's terminal now, or null where this service opens none. */
  terminal(): Promise<TerminalView | null> {
    return this.#o.terminal?.view() ?? Promise.resolve(null);
  }

  /**
   * Chooses Open's terminal: `auto`, the operating system's default, takes `[terminal] app` out of
   * machine.toml; another is one of the terminals found here, or the one machine.toml names now.
   * A `path` belongs to the terminal it was written for, so choosing another one takes it out.
   */
  setTerminal(app: unknown): Promise<TerminalView | null> {
    const port = this.#o.terminal;
    if (port === undefined) return Promise.reject(notASetting());
    if (typeof app !== "string" || !(TERMINAL_APPS as readonly string[]).includes(app)) {
      return Promise.reject(refused("invalid_value"));
    }
    const chosen = app as TerminalSettings["app"];
    return this.#run(async () => {
      const current = port.settings();
      if (chosen !== "auto" && chosen !== current.app) {
        const view = await port.view();
        if (view === null || !view.installed.includes(chosen)) {
          throw new AppError({
            code: "not_found",
            message: "That terminal was not found on this machine.",
          });
        }
      }
      // Decided on the file as it is now, which an editor may have changed since the start.
      const prepared = prepareEditOf(this.#o.configDir, (doc) => {
        const table = doc["terminal"];
        const written = isRecord(table) ? table : {};
        const edits: Edit[] =
          chosen === "auto"
            ? [{ op: "unset", table: ["terminal"], key: "app" }]
            : [{ op: "set", table: ["terminal"], key: "app", value: chosen }];
        if ((written["app"] ?? "auto") !== chosen && written["path"] !== undefined) {
          edits.push({ op: "unset", table: ["terminal"], key: "path" });
        }
        return edits;
      });
      if (!prepared.ok) throw refused(prepared.reason);
      const { before, text } = prepared.edit;
      const same = before === undefined ? text === "" : before.equals(Buffer.from(text, "utf8"));
      if (!same) {
        const edited = commitEdit(prepared.edit);
        if (!edited.ok) throw refused(edited.reason);
      }
      // The next Open follows the file's app and path; the rest of `[terminal]` waits for a start,
      // like every other hand edit.
      const now = parseMachineConfig(
        text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
        this.#o.platform,
      ).config.terminal;
      port.apply({ ...current, app: chosen, path: now.path });
      this.#o.log.log("config.terminal_set", { app: chosen });
      return port.view();
    });
  }
}
