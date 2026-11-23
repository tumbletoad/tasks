import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeFrames } from "../../test/fake-frames.ts";
import { SignedOut, StaleBuild, type Api } from "../api.ts";
import { Live } from "./client.ts";

const SPACE = "sp_00000000000000000000000000";

/** A WebSocket the test drives: what the page sent, and the service's side by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  readyState = 1;
  onmessage: ((event: { data: unknown }) => void) | undefined;
  onclose: ((event: { code: number }) => void) | undefined;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {
    // The page's own close: nothing comes back.
  }
  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const cursor = (seq: number) => ({ epoch: 1, incarnation: "ai_x", seq });
const task = (id: string, title: string) => ({
  id,
  ref: `M-${id}`,
  title,
  status: "open",
  inbox: true,
  lifecycle: "active",
  position: "a",
  created_at: 0,
  version: 1,
});
const snapshot = (seq: number, tasks: unknown[] = []) => ({
  type: "snapshot",
  space: { id: SPACE, name: "Mira", ref_prefix: "M" },
  cursor: cursor(seq),
  tasks,
  areas: [],
  projects: [],
  instances: [],
});
const batch = (from: number, through: number, events: unknown[] = [], space = SPACE) => ({
  type: "batch",
  space_id: space,
  epoch: 1,
  incarnation: "ai_x",
  from,
  through,
  events,
});
let seqs = 0;
const taskEvent = (row: ReturnType<typeof task>, seq?: number) => ({
  seq: seq ?? (seqs += 1),
  request_id: "",
  entities: [{ type: "task", id: row.id, row, changed: [] }],
});

let frames: FakeFrames;

function start(space = SPACE): Live {
  const api = { ticket: () => Promise.resolve("t".repeat(32)) } as unknown as Api;
  const live = new Live({
    api,
    route: { space },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames,
  });
  live.start();
  return live;
}

const socket = () => {
  const ws = FakeSocket.all.at(-1);
  if (ws === undefined) throw new Error("no socket");
  return ws;
};

/** The service's message, applied at the next frame. */
const receive = (message: Record<string, unknown>) => {
  socket().receive(message);
  frames.frame();
};

beforeEach(() => {
  FakeSocket.all = [];
  frames = new FakeFrames();
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { host: "127.0.0.1:1" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("[A5.3.15.web.live] the tab's feed client", () => {
  test("batches apply once and in order; a gap or another space asks for a fresh snapshot", async () => {
    const live = start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: SPACE });
    receive(snapshot(5));
    expect(live.getState().phase).toBe("live");

    receive(batch(5, 6, [taskEvent(task("a", "One"), 6)]));
    // The same batch again is a repeat (A1 3.7): nothing applies and nothing is asked for.
    const sent = socket().sent.length;
    receive(batch(5, 6, [taskEvent(task("b", "Two"), 6)]));
    expect([...live.getState().tasks.keys()]).toEqual(["a"]);
    expect(socket().sent).toHaveLength(sent);
    // A gap: a fresh snapshot.
    receive(batch(7, 8, [taskEvent(task("d", "Four"), 8)]));
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: SPACE });
    // Batches of the replaced subscription wait for the snapshot.
    receive(batch(6, 7, [taskEvent(task("c", "Three"), 7)]));
    expect([...live.getState().tasks.keys()]).toEqual(["a"]);
    receive(snapshot(8, [task("a", "One"), task("c", "Three"), task("d", "Four")]));
    expect([...live.getState().tasks.keys()]).toEqual(["a", "c", "d"]);

    // Another space's batch never lands in this tab.
    receive(batch(8, 9, [taskEvent(task("x", "Elsewhere"), 9)], "sp_11111111111111111111111111"));
    expect(live.getState().tasks.has("x")).toBe(false);
    live.stop();
  });

  test("a restored copy's tab subscribes by the copy's address, every time, and takes its space's snapshot with why it is read-only", async () => {
    const copy = `${SPACE}-copy-0123456789ab`;
    const live = start(copy);
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: copy });
    const why = { reason: "read_only_copy", message: "This is a restored copy." };
    receive({
      ...snapshot(5),
      space: { id: SPACE, name: "Mira", ref_prefix: "M", read_only: why },
    });
    expect(live.getState().phase).toBe("live");
    expect(live.getState().space?.read_only).toEqual(why);
    // Its kept text is kept under the copy's address, apart from the original's.
    expect(live.address).toBe(copy);
    expect(live.spaceId).toBe(SPACE);
    // A gap asks again for the copy, never for the space's ID (which means the original).
    receive(batch(7, 8));
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: copy });
    live.stop();
  });

  test("a feed that resumes from its cursor is live again without a snapshot", async () => {
    const live = start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    receive(snapshot(5, [task("a", "One")]));
    expect(live.getState().phase).toBe("live");

    // A batch arrived and waits for its frame when the socket drops.
    socket().receive(batch(5, 6, [taskEvent(task("b", "Two"), 6)]));
    socket().drop();
    expect(live.getState().phase).toBe("offline");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    // The rows stay while the feed reconnects, and so does the add field (shown when live or offline).
    expect(live.getState().phase).toBe("offline");
    socket().receive({ type: "hello", build: "b" });
    // It resumes after what it received: the queued batch applied first.
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: SPACE, cursor: cursor(6) });
    // Nothing changed while away: the service sends no snapshot and, until its heartbeat, nothing.
    expect(live.getState().phase).toBe("live");
    expect([...live.getState().tasks.keys()]).toEqual(["a", "b"]);
    receive(batch(6, 6));
    expect(live.getState().phase).toBe("live");

    // The next drop waits 1 s again: the resumed feed reset the backoff.
    socket().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(3);
    live.stop();
  });

  test("signed out stays signed out: nothing queued or still arriving makes the tab live", async () => {
    let signedOut = 0;
    const api = { ticket: () => Promise.resolve("t".repeat(32)) } as unknown as Api;
    const live = new Live({
      api,
      route: { space: SPACE },
      build: "",
      onSpace: () => undefined,
      onSignedOut: () => (signedOut += 1),
      frames,
    });
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    // A snapshot waits for its frame when the service closes the socket as signed out.
    socket().receive(snapshot(5, [task("a", "One")]));
    socket().drop(4401);
    expect(live.getState().phase).toBe("signed_out");
    frames.frame();
    expect(live.getState().phase).toBe("signed_out");
    expect(live.getState().tasks.size).toBe(0);
    expect(signedOut).toBe(1);

    // An API call finds the token gone while the socket is still open: what it still sends is dropped.
    const second = start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    receive(snapshot(5, [task("a", "One")]));
    expect(second.failed(new SignedOut())).toBe(true);
    socket().receive(batch(5, 6, [taskEvent(task("b", "Two"), 6)]));
    frames.frame();
    expect(second.getState().phase).toBe("signed_out");
    expect([...second.getState().tasks.keys()]).toEqual(["a"]);
  });

  test("a fresh snapshot asked for while the socket is down is asked for on the next one", async () => {
    const live = start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    receive(snapshot(5, [task("a", "One")]));
    // A gap arrives, and the socket drops before its frame.
    socket().receive(batch(9, 10));
    socket().drop();
    frames.frame();
    await vi.advanceTimersByTimeAsync(1_000);
    socket().receive({ type: "hello", build: "b" });
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: SPACE });

    // A gap still queued when the next socket greets: one subscription, without a cursor.
    receive(snapshot(10, [task("a", "One")]));
    socket().receive(batch(12, 13));
    socket().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    socket().receive({ type: "hello", build: "b" });
    expect(socket().sent).toEqual([{ type: "subscribe", space: SPACE }]);
    live.stop();
  });

  test("a refresh takes a fresh snapshot on the same session: what Open offers follows", async () => {
    const live = start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    receive(snapshot(5, [task("a", "One")]));
    const before = live.getState().instances;
    // A batch that arrived before the refresh, its frame not run yet, still applies.
    const changed: string[] = [];
    live.onChanges(({ changes }) => {
      changed.push(...changes.map((c) => c.id));
    });
    socket().receive(batch(5, 6, [taskEvent(task("a", "Two"), 6)]));
    live.refresh();
    expect(live.getState().tasks.get("a")?.title).toBe("Two");
    expect(changed).toEqual(["a"]);
    expect(socket().sent.at(-1)).toEqual({ type: "subscribe", space: SPACE });
    // A batch from before the new snapshot is not applied over it.
    receive(batch(6, 7, [taskEvent(task("a", "Old"), 7)]));
    expect(live.getState().tasks.get("a")?.title).toBe("Two");
    const instance = { key: "claude", label: "Claude Code", glyph: "C", ring: 0, route: "cli" };
    receive({ ...snapshot(8, [task("a", "Two")]), instances: [instance] });
    expect(live.getState().phase).toBe("live");
    expect(live.getState().instances).not.toBe(before);
    expect(live.getState().instances.map((i) => i.key)).toEqual(["claude"]);
    live.stop();
    live.refresh();
    expect(socket().sent.filter((m) => m["type"] === "subscribe")).toHaveLength(2);
  });
});

describe("[A5.3.15.web.installed] the page and a newer installed version", () => {
  test("hello and installed say which version a restart switches to; the same version again clears it", async () => {
    const live = start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b", version: "0.1.0", installed: "0.2.0" });
    expect(live.getState().installed).toEqual({ version: "0.2.0", running: "0.1.0" });
    receive(snapshot(5));
    expect(live.getState().installed).toEqual({ version: "0.2.0", running: "0.1.0" });
    // Rolled back while the service ran: it runs the installed version again.
    socket().receive({ type: "installed" });
    expect(live.getState().installed).toBeUndefined();
    socket().receive({ type: "installed", version: "0.3.0" });
    expect(live.getState().installed).toEqual({ version: "0.3.0", running: "0.1.0" });
    // A version that is no version name is not shown.
    socket().receive({ type: "installed", version: "<b>0.4</b>" });
    expect(live.getState().installed).toBeUndefined();
    live.stop();
  });

  test("after a restart into another build the page is stale, keeps its rows and stops asking", async () => {
    let stale = false;
    let tickets = 0;
    const api = {
      ticket: () => {
        tickets += 1;
        return stale ? Promise.reject(new StaleBuild()) : Promise.resolve("t".repeat(32));
      },
    } as unknown as Api;
    const live = new Live({
      api,
      route: { space: SPACE },
      build: "b1",
      onSpace: () => undefined,
      onSignedOut: () => undefined,
      frames,
    });
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b1", version: "0.1.0", installed: "0.2.0" });
    receive(snapshot(5, [task("a", "One")]));
    // The service stops for its restart, and comes back as another build: the page's ticket is
    // refused for its build.
    stale = true;
    socket().drop(1001);
    expect(live.getState().phase).toBe("offline");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.getState().stale).toBe(true);
    // Its rows stay, and it asks nothing more of the service until the person reloads.
    expect([...live.getState().tasks.keys()]).toEqual(["a"]);
    const asked = tickets;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(tickets).toBe(asked);
    live.stop();
  });
});

/** A tab whose visibility and focus the test sets. */
function attention(visible: boolean, focused: boolean) {
  const listeners = new Set<() => void>();
  const state = { visible, focused };
  return {
    state,
    port: {
      visible: () => state.visible,
      focused: () => state.focused,
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(next: { visible?: boolean; focused?: boolean }) {
      Object.assign(state, next);
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

const PICTURE = {
  ageMs: 0,
  settling: false,
  sessions: [
    {
      key: "k1",
      app: "claude",
      appName: "claude",
      account: "claude",
      title: "Release checklist",
      folder: "/home/mira/projects/portal",
      activity: "working",
      ageMs: 60_000,
      quietMs: 1_000,
      nested: [],
    },
  ],
  accounts: [],
};

function watching(tab: ReturnType<typeof attention>): Live {
  const live = new Live({
    api: { ticket: () => Promise.resolve("t".repeat(32)) } as unknown as Api,
    route: { space: SPACE },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames,
    attention: tab.port,
  });
  live.start();
  return live;
}

describe("[A5.agents.web-watch] the tab tells the service whether it watches the Agents page", () => {
  test("mounted, visible and focused on each change and after every hello; the view is kept while mounted", async () => {
    const tab = attention(true, true);
    const live = watching(tab);
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    const watches = () => socket().sent.filter((m) => m["type"] === "watch");
    // A tab without an Agents page tells nothing, and takes no view.
    expect(watches()).toEqual([]);
    socket().receive({ type: "agents", picture: PICTURE, trouble: null });
    expect(live.agents.getState().view).toBeUndefined();

    const unwatch = live.watchAgents();
    expect(watches()).toEqual([{ type: "watch", agents: true, visible: true, focused: true }]);
    socket().receive({ type: "agents", picture: PICTURE, trouble: null });
    expect(live.agents.getState().view?.picture?.sessions[0]?.title).toBe("Release checklist");
    tab.set({ focused: false });
    tab.set({ visible: false });
    // The same facts again tell nothing new.
    tab.set({ visible: false });
    expect(watches().slice(1)).toEqual([
      { type: "watch", agents: true, visible: true, focused: false },
      { type: "watch", agents: true, visible: false, focused: false },
    ]);

    // A reconnect: the new connection is told at its hello.
    socket().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    socket().receive({ type: "hello", build: "b" });
    expect(watches()).toEqual([{ type: "watch", agents: true, visible: false, focused: false }]);

    // The page unmounts: the service is told, the view is dropped, and the tab stops listening.
    unwatch();
    expect(watches().at(-1)).toEqual({
      type: "watch",
      agents: false,
      visible: false,
      focused: false,
    });
    expect(live.agents.getState().view).toBeUndefined();
    expect(tab.listening()).toBe(0);
    live.stop();
  });

  test("a lost feed makes the view not current; the next connection watches again and its view is", async () => {
    const live = watching(attention(true, true));
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    const unwatch = live.watchAgents();
    socket().receive({ type: "agents", picture: PICTURE, trouble: null });
    expect(live.agents.getState().current).toBe(true);
    // The service restarts: the picture stays, as it was.
    socket().drop(1001);
    expect(live.agents.getState()).toMatchObject({ current: false, view: { picture: PICTURE } });
    await vi.advanceTimersByTimeAsync(1_000);
    socket().receive({ type: "hello", build: "b" });
    // Told again at once, and still not current until the service's view comes.
    expect(socket().sent.filter((m) => m["type"] === "watch")).toEqual([
      { type: "watch", agents: true, visible: true, focused: true },
    ]);
    expect(live.agents.getState().current).toBe(false);
    socket().receive({ type: "agents", picture: null, trouble: null });
    expect(live.agents.getState()).toMatchObject({ current: true, view: { picture: null } });
    // A view that says the monitor is in trouble is not current either.
    socket().receive({ type: "agents", picture: PICTURE, trouble: { kind: "slow" } });
    expect(live.agents.getState().current).toBe(false);
    unwatch();
    live.stop();
  });

  test("a service of another build: the view is not current, and the page neither watches nor takes one", async () => {
    const tab = attention(true, true);
    const live = new Live({
      api: { ticket: () => Promise.resolve("t".repeat(32)) } as unknown as Api,
      route: { space: SPACE },
      build: "b1",
      onSpace: () => undefined,
      onSignedOut: () => undefined,
      frames,
      attention: tab.port,
    });
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b1" });
    const unwatch = live.watchAgents();
    socket().receive({ type: "agents", picture: PICTURE, trouble: null });
    expect(live.agents.getState().current).toBe(true);
    socket().drop(1001);
    await vi.advanceTimersByTimeAsync(1_000);
    socket().receive({ type: "hello", build: "b2" });
    expect(live.getState().stale).toBe(true);
    expect(live.agents.getState()).toMatchObject({ current: false, view: { picture: PICTURE } });
    expect(socket().sent.filter((m) => m["type"] === "watch")).toEqual([]);
    socket().receive({ type: "agents", picture: PICTURE, trouble: null });
    expect(live.agents.getState().current).toBe(false);
    unwatch();
    live.stop();
  });

  test("a view of another shape is no view", async () => {
    const live = watching(attention(true, true));
    await vi.advanceTimersByTimeAsync(0);
    socket().receive({ type: "hello", build: "b" });
    const unwatch = live.watchAgents();
    socket().receive({ type: "agents", picture: "nope", trouble: null });
    socket().receive({ type: "agents", picture: null, trouble: { kind: "nope" } });
    expect(live.agents.getState().view).toBeUndefined();
    socket().receive({
      type: "agents",
      picture: null,
      trouble: { kind: "not_installed", reason: "not_found" },
    });
    expect(live.agents.getState().view?.trouble).toEqual({
      kind: "not_installed",
      reason: "not_found",
    });
    unwatch();
    live.stop();
  });
});
