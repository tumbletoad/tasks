// The page's requests to its service (A2 3.8.3, 3.8.4): JSON POSTs on the page's own origin, with
// the bearer token, the build the page was served with, and the tab's space in every call. No
// cookies, no credentials, no referrer, nothing cached. The token never goes into a URL, and the
// WebSocket gets a single-use ticket instead (live.ts).
//
// Registry entries go through contracts' generated client (`/api/v1/op/<entry>`): Open and Copy
// are A4's `launch.open`. The agent apps busy here, a task's receipts, and Run, a task's runs and
// Stop, have routes of their own (`/api/v1/launch/…`).
import { httpHeader } from "@tasks/brand";
import { createClient, type Client } from "@tasks/contracts/generated/client.ts";
import { TOKEN_SHAPE } from "./stored.ts";

/** The headers the service reads (its http/app.ts): names from the identifier, never a display name. */
const BUILD_HEADER = httpHeader("build");
const SPACE_HEADER = httpHeader("space");

/** An instance the page draws a tile for (the service's UiInstance). */
export interface Instance {
  readonly key: string;
  readonly label: string;
  readonly glyph: string;
  readonly ring: number;
  readonly route: string;
  /** It can work on a task in the background: Run. */
  readonly runs?: true;
}

/**
 * A background run as the page shows it (the service's UiRun). `asked`, `answer` and `error` are
 * the person's and the agent's text: shown as untrusted text, never HTML.
 */
export interface Run {
  readonly id: string;
  readonly instance: string;
  readonly state: string;
  readonly reason: string | null;
  /** Why a queued run waits. */
  readonly waiting?: string;
  readonly queued_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  /** The person's words; null: the run works on the task. */
  readonly asked: string | null;
  readonly outcome?: string;
  readonly cleanup?: string;
  /** The agent's answer, or its question when it needs the person. */
  readonly answer: string | null;
  readonly answer_final: boolean;
  readonly answer_cut: boolean;
  readonly error?: string;
  /** Grows with every change of the run: of two reads, the higher is newer. */
  readonly version: number;
}

export type ReceiptState =
  "prepared" | "dispatching" | "dispatched" | "confirmed" | "failed" | "unknown";

/**
 * An agent app busy with a task on this machine (the service's UiBusy): an Open of it is on its
 * way, or a session of it runs.
 */
export interface Busy {
  readonly task: string;
  readonly instance: string;
  readonly state: "opening" | "running";
}

/** A launch receipt (the service's UiReceipt): IDs, states, instants and codes only. */
export interface Receipt {
  readonly id: string;
  readonly reference: string;
  readonly instance: string;
  readonly route: string;
  readonly state: ReceiptState;
  readonly reason: string | null;
  readonly at: Readonly<Partial<Record<ReceiptState, number>>>;
  /** A terminal launch: the terminal Dispatched and why it was chosen, as fixed words. */
  readonly terminal?: { readonly app: string; readonly source: string };
  /**
   * The words the person typed, which Tasks holds for the launch's agent: `waiting` until the
   * agent read them, `read` once it did, `unread` when they went with a launch whose agent never
   * read them. Absent when none are known (none were held, or the service restarted since).
   */
  readonly request?: "waiting" | "read" | "unread";
  /**
   * A Confirmed launch's session as the service knows it: `running` now, or `ended`. Absent when
   * it cannot know, which the page never shows as running.
   */
  readonly session?: "running" | "ended";
  /** How long its agent ran, when its end was reported with it. */
  readonly ran_ms?: number;
}

/** Open's terminal as Settings shows it (the service's TerminalView): fixed words only. */
export interface TerminalView {
  /** machine.toml's choice: `auto` follows the operating system's default. */
  readonly chosen: string;
  readonly used: { readonly app: string; readonly source: string; readonly found: boolean } | null;
  readonly unsupported: string | null;
  readonly unread: "windows" | "desktop" | null;
  readonly installed: readonly string[];
}

/** The service refused the token: it expired or was revoked. */
export class SignedOut extends Error {}
/** The service runs another build than the one that served this page. */
export class StaleBuild extends Error {}
/** The service answered with an error: its code, or `unknown` when the answer had none. */
export class Refused extends Error {
  readonly status: number;
  readonly code: string;
  /** The service's own sentence for the person, when it gave one. */
  readonly said: string | undefined;
  /** The answer's `data`: why, in the service's fixed words. */
  readonly data: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: string,
    said?: string,
    data: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.said = said;
    this.data = data;
  }
}

/** A space the page made or opened. */
export interface MadeSpace {
  readonly id: string;
  readonly name: string;
  /** The space will not reopen after a restart: why, and what to do. */
  readonly notRemembered?: string;
}

function madeSpace(value: unknown): MadeSpace {
  const { id, name, not_remembered: line } = (value ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string") throw new Refused(200, "unknown");
  return {
    id,
    name,
    ...(typeof line === "string" && line.length <= 2000 ? { notRemembered: line } : {}),
  };
}

/** A project a listed folder belongs to. */
export interface FolderProject {
  readonly id: string;
  readonly name: string;
}

/** The folder a person's text names exactly (the service's `Exact`). */
export interface ExactFolder {
  /** As the space stores it, the home as `~`. */
  readonly folder: string;
  /** The name a project made from it gets: none for a drive or a root. */
  readonly name?: string;
  readonly repo?: string;
  readonly project?: FolderProject;
}

/** What the folder chooser shows for a text (the service's ops/listing.ts `Listing`). */
export type FolderListing =
  | {
      readonly kind: "start";
      readonly sep: string;
      readonly places: readonly { readonly folder: string; readonly project?: string }[];
      readonly roots: readonly string[];
    }
  | {
      readonly kind: "list";
      readonly sep: string;
      readonly at: string;
      readonly prefix: string;
      /** The folder that holds `at`; none at a root. */
      readonly up?: string;
      readonly folders: readonly {
        readonly name: string;
        readonly link?: true;
        readonly project?: FolderProject;
      }[];
      readonly more: boolean;
      readonly exact?: ExactFolder;
    }
  | {
      readonly kind: "problem";
      readonly sep: string;
      readonly reason: string;
      readonly at?: string;
    };

/** A project's folder line: its folder here, and the machines where it has one. */
export interface ProjectFolderView {
  readonly here?: {
    readonly folder: string;
    readonly state: "here" | "missing";
    readonly repo?: string;
  };
  readonly elsewhere: readonly string[];
}

/** A fresh request ID (A1 3.8): 128 random bits, new per intended change. */
export const requestId = (): string => crypto.randomUUID();

async function postJson(
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const reply = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    redirect: "error",
  });
  return { status: reply.status, body: await reply.text() };
}

/** `POST /api/v1/auth/redeem`: a fragment code for a token, or null. */
export async function redeem(code: string): Promise<string | null> {
  const reply = await postJson("/api/v1/auth/redeem", JSON.stringify({ code }), {});
  if (reply.status !== 200) return null;
  try {
    const token = (JSON.parse(reply.body) as { token?: unknown }).token;
    return typeof token === "string" && TOKEN_SHAPE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** A session's calls: its token, the page's build, and the tab's space. */
export class Api {
  readonly #token: string;
  readonly #build: string;
  readonly #space: () => string | undefined;
  readonly client: Client;

  constructor(token: string, build: string, space: () => string | undefined) {
    this.#token = token;
    this.#build = build;
    this.#space = space;
    this.client = createClient({ post: (path, body) => this.post(path, body) });
  }

  async post(path: string, body: string): Promise<{ status: number; body: string }> {
    const space = this.#space();
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
    if (this.#build !== "") headers[BUILD_HEADER] = this.#build;
    if (space !== undefined) headers[SPACE_HEADER] = space;
    const reply = await postJson(path, body, headers);
    if (reply.status === 401) throw new SignedOut();
    if (reply.status === 409 && reply.body.includes('"reason":"build"')) throw new StaleBuild();
    return reply;
  }

  async #result<T>(path: string, input: unknown): Promise<T> {
    const reply = await this.post(path, JSON.stringify(input));
    const parsed = JSON.parse(reply.body) as {
      result?: T;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (reply.status !== 200 || parsed.result === undefined) {
      const code = parsed.error?.code;
      const message = parsed.error?.message;
      const data = parsed.error?.data;
      throw new Refused(
        reply.status,
        typeof code === "string" ? code : "unknown",
        typeof message === "string" && message.length <= 500 ? message : undefined,
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {},
      );
    }
    return parsed.result;
  }

  /** What a new space of this name gets unless the person chooses: its prefix and its folder. */
  async proposeSpace(name: string): Promise<{ prefix: string; folder: string }> {
    const reply = await this.#result<{ ref_prefix?: unknown; folder?: unknown }>(
      "/api/v1/space/propose",
      { name },
    );
    return {
      prefix: typeof reply.ref_prefix === "string" ? reply.ref_prefix : "",
      folder: typeof reply.folder === "string" ? reply.folder : "",
    };
  }

  /** New space: the name, and the prefix and folder when the person chose them. */
  async createSpace(input: {
    readonly name: string;
    readonly prefix?: string;
    readonly folder?: string;
  }): Promise<MadeSpace> {
    return madeSpace(
      await this.#result("/api/v1/space/create", {
        name: input.name,
        ...(input.prefix === undefined ? {} : { ref_prefix: input.prefix }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
      }),
    );
  }

  /** Open folder: a space folder on this machine, served from now on. */
  async openSpace(folder: string): Promise<MadeSpace> {
    return madeSpace(await this.#result("/api/v1/space/open", { folder }));
  }

  /** This machine's agent apps, for `space`: what a new entry names. */
  async agentApps(space: string): Promise<unknown> {
    return this.#result("/api/v1/machine/apps", { space });
  }

  /** The switches the person turned over, each with the token its view showed. */
  async applyAgentApps(space: string, changes: readonly unknown[]): Promise<unknown> {
    return this.#result("/api/v1/machine/apps_apply", { space, changes });
  }

  /** The folder chooser: the folders in the folder `path` names, or where to begin. */
  async folders(path: string): Promise<FolderListing> {
    return this.#result("/api/v1/machine/folders", { path });
  }

  /** The folder chooser's new folder, in a folder that exists. */
  async makeFolder(path: string): Promise<{ folder?: string; reason?: string }> {
    return this.#result("/api/v1/machine/folder_make", { path });
  }

  /** A project's folder here, with its repository, and the machines where it has one. */
  async projectFolder(project: string): Promise<ProjectFolderView> {
    return this.#result("/api/v1/machine/project_folder", { project });
  }

  /** A single-use ticket for the feed's WebSocket. */
  async ticket(): Promise<string> {
    const reply = await this.post("/api/v1/ws-ticket", "{}");
    const ticket =
      reply.status === 200 ? (JSON.parse(reply.body) as { ticket?: unknown }).ticket : undefined;
    if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) {
      throw new Error("The service gave no ticket");
    }
    return ticket;
  }

  /**
   * A click on a tile, or on Copy without an instance (A4's `launch.open`): the launch's receipt,
   * and for Copy (or an open whose app takes the brief by paste) the text for the clipboard.
   * `text` is what the person typed in the composer: the agent's request.
   */
  async openLaunch(
    task: string,
    instance: string | undefined,
    id: string,
    {
      pack = false,
      text,
      markFolder = false,
    }: { readonly pack?: boolean; readonly text?: string; readonly markFolder?: boolean } = {},
  ): Promise<{ receipt: Receipt; copy: string | undefined }> {
    const result = await this.client.launch.open({
      task,
      ...(instance === undefined ? {} : { instance }),
      // Shift+Copy (A4 3.15.5): the context pack in place of the pointer brief.
      ...(pack ? { pack: true } : {}),
      ...(text === undefined || text.trim() === "" ? {} : { text }),
      // The person chose to open the task in a folder whose marker is gone or another's.
      ...(markFolder ? { mark_folder: true } : {}),
      request_id: id,
    });
    const { launch } = result;
    const at: Partial<Record<ReceiptState, number>> = {};
    for (const [state, value] of Object.entries(launch.at)) {
      if (typeof value === "number") at[state as ReceiptState] = value;
    }
    return {
      receipt: {
        id: launch.id,
        reference: launch.reference,
        instance: launch.instance,
        route: launch.route,
        state: launch.state,
        reason: launch.reason ?? null,
        at,
        // Open holds the words for the agent: they wait until it reads them.
        ...(result.text === "held" ? { request: "waiting" as const } : {}),
      },
      copy: result.copy,
    };
  }

  /** Sets one of this machine's settings of the page, or resets it with null. */
  async setMachinePreference(
    key: string,
    value: unknown,
  ): Promise<{ readonly key: string; readonly value: unknown; readonly state: string }> {
    return this.#result("/api/v1/machine/pref", { key, value });
  }

  /** Open's terminal, and with `app` the choice of one (`auto`: the system's default). */
  async terminal(app?: string): Promise<TerminalView | null> {
    const reply = await this.#result<{ terminal: TerminalView | null }>(
      "/api/v1/machine/terminal",
      app === undefined ? {} : { app },
    );
    return reply.terminal;
  }

  /** The agent apps busy with a task on this machine, for every task of the space. */
  async busy(): Promise<Busy[]> {
    const reply = await this.#result<{ busy: Busy[] }>("/api/v1/launch/busy", {});
    return reply.busy;
  }

  /**
   * Shows the task's folder in the file manager of the computer the service runs on, which the
   * answer names. The service reads the folder from the task.
   */
  async showFolder(task: string): Promise<{
    readonly opened: boolean;
    readonly machine: string | undefined;
  }> {
    const reply = await this.#result<{ result?: unknown; machine?: unknown }>(
      "/api/v1/launch/folder",
      { task },
    );
    return {
      // "unknown": the file manager was asked and did not say whether it opened the folder.
      opened: reply.result === "opened",
      machine: typeof reply.machine === "string" ? reply.machine : undefined,
    };
  }

  async receipts(task: string): Promise<Receipt[]> {
    const reply = await this.#result<{ receipts: Receipt[] }>("/api/v1/launch/list", { task });
    return reply.receipts;
  }

  /**
   * Run: `instance` works on the task in the background, with `text` as its request, or on the
   * task itself without one. The words go in the body, never a URL. The same `id` again is the
   * same run.
   */
  async startRun(task: string, instance: string, id: string, text?: string): Promise<Run> {
    const reply = await this.#result<{ run: Run }>("/api/v1/launch/run", {
      task,
      instance,
      request_id: id,
      ...(text === undefined || text.trim() === "" ? {} : { text }),
    });
    return reply.run;
  }

  /** A task's newest runs, oldest first. */
  async runs(task: string): Promise<Run[]> {
    const reply = await this.#result<{ runs: Run[] }>("/api/v1/launch/runs", { task });
    return reply.runs;
  }

  /** Stop: the run as it is right after the service took the Stop. */
  async stopRun(run: string): Promise<Run> {
    const reply = await this.#result<{ run: Run }>("/api/v1/launch/stop", { run });
    return reply.run;
  }
}
