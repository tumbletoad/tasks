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

function start(): Live {
  const api = { ticket: () => Promise.resolve("t".repeat(32)) } as unknown as Api;
  const live = new Live({
    api,
    route: { space: SPACE },
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
    const api = {
      ticket: () => (stale ? Promise.reject(new StaleBuild()) : Promise.resolve("t".repeat(32))),
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
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    live.stop();
  });
});
