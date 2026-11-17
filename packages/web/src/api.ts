// The page's requests to its service (A2 3.8.3, 3.8.4): JSON POSTs on the page's own origin, with
// the bearer token, the build the page was served with, and the tab's space in every call. No
// cookies, no credentials, no referrer, nothing cached. The token never goes into a URL, and the
// WebSocket gets a single-use ticket instead (live.ts).
//
// Registry entries go through contracts' generated client (`/api/v1/op/<entry>`): Open and Copy
// are A4's `launch.open`. A task's receipts have a route of their own (`/api/v1/launch/list`).
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
}

export type ReceiptState =
  "prepared" | "dispatching" | "dispatched" | "confirmed" | "failed" | "unknown";

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

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
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
    const parsed = JSON.parse(reply.body) as { result?: T; error?: { code?: unknown } };
    if (reply.status !== 200 || parsed.result === undefined) {
      const code = parsed.error?.code;
      throw new Refused(reply.status, typeof code === "string" ? code : "unknown");
    }
    return parsed.result;
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

  /** Sets one of this computer's settings of the page, or resets it with null. */
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

  async receipts(task: string): Promise<Receipt[]> {
    const reply = await this.#result<{ receipts: Receipt[] }>("/api/v1/launch/list", { task });
    return reply.receipts;
  }
}
