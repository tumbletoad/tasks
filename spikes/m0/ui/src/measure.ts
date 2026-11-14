// Row U07 (A5 M0-4): scrolling through 5,000 rows, a view switch and a burst of 100 events,
// measured with the Performance API and requestAnimationFrame timing, against A5 3.25:
//   scrolling the list: 60 fps, rendered rows the visible ones plus 10 above and below;
//   view switch (derive, group and render the visible rows): <= 100 ms;
//   a burst of 100 events: <= 16 ms of main-thread work per frame.
// Started by ?measure=u07, so it runs unattended. Numbers only go to the service.
import { makeBurst, rng, type LiveEvent, type ViewName } from "./data.ts";
import type { ListHandle } from "./List.tsx";
import { metric, record, report } from "./report.ts";

export interface Harness {
  handle: ListHandle;
  view(): ViewName;
  liveIds(): number[];
  /** Derives the view and renders it synchronously (flushSync). Returns the derive time. */
  switchView(view: ViewName): number;
  /** Applies the events, derives the view and renders it synchronously. Returns the derive time. */
  applyBurst(events: readonly LiveEvent[]): number;
}

export const TARGETS = {
  frameMs: 1000 / 60,
  /** p95 frame interval that still reads as 60 fps: one frame plus 5 % jitter. */
  frameP95Ms: (1000 / 60) * 1.05,
  viewSwitchMs: 100,
  burstWorkMs: 16,
  heapMb: 200,
  firstListMs: 800,
} as const;

const now = () => performance.now();
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
/** Resolves after the next frame has been produced: a message posted from its rAF callback. */
const afterPaint = () =>
  new Promise<number>((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        resolve(now());
      };
      channel.port2.postMessage(0);
    });
  });

export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentiles, as the other lab rows use. */
export function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  return {
    n: sorted.length,
    mean,
    p50: rank(50),
    p95: rank(95),
    p99: rank(99),
    max: sorted.at(-1) ?? 0,
  };
}

function put(prefix: string, s: Stats): void {
  for (const key of ["n", "mean", "p50", "p95", "p99", "max"] as const) {
    metric(`${prefix}_${key}`, s[key]);
  }
}

let hidden = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") hidden = true;
});

/** Long animation frames (Chromium) and long tasks, where the browser supports them. */
function observe(type: string): { stop(): number[] } | undefined {
  if (!PerformanceObserver.supportedEntryTypes.includes(type)) return undefined;
  const durations: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) durations.push(entry.duration);
  });
  observer.observe({ type, buffered: false });
  return {
    stop() {
      observer.disconnect();
      return durations;
    },
  };
}

async function scrollThrough(h: Harness, step: number): Promise<void> {
  const el = h.handle.scroller;
  if (el === null) throw new Error("no scroller");
  el.scrollTop = 0;
  for (let i = 0; i < 5; i++) await nextFrame();
  const loaf = observe("long-animation-frame");
  const longtask = observe("longtask");
  const intervals: number[] = [];
  const work: number[] = [];
  let maxRendered = 0;
  let workStart = 0;
  // The capture listener on window runs before the virtualizer's listener on the scroller, and
  // the target listener added now runs after it, so the difference is the scroll handling work,
  // the virtualizer's synchronous React render and commit included.
  const before = () => {
    workStart = now();
  };
  const after = () => {
    if (workStart > 0) work.push(now() - workStart);
    workStart = 0;
  };
  window.addEventListener("scroll", before, { capture: true, passive: true });
  el.addEventListener("scroll", after, { passive: true });
  const started = now();
  await new Promise<void>((resolve) => {
    let last = 0;
    const tick = (time: number) => {
      if (last > 0) intervals.push(time - last);
      last = time;
      maxRendered = Math.max(maxRendered, h.handle.rendered);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        resolve();
        return;
      }
      el.scrollTop += step;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const duration = now() - started;
  window.removeEventListener("scroll", before, { capture: true });
  el.removeEventListener("scroll", after);
  const frames = stats(intervals);
  put("u07_scroll_frame", frames);
  put("u07_scroll_work", stats(work));
  const over = (limit: number) => intervals.filter((v) => v > limit).length;
  metric("u07_scroll_duration_ms", duration);
  metric(
    "u07_scroll_fps",
    (intervals.length * 1000) /
      Math.max(
        1,
        intervals.reduce((a, b) => a + b, 0),
      ),
  );
  metric("u07_scroll_frames_over_16_7", over(TARGETS.frameMs + 0.5));
  metric("u07_scroll_frames_over_25", over(25));
  metric("u07_scroll_frames_over_50", over(50));
  metric("u07_scroll_step_px", step);
  metric("u07_scroll_height_px", el.scrollHeight);
  metric("u07_viewport_px", el.clientHeight);
  metric("u07_rendered_max", maxRendered);
  // Visible rows plus 10 above and below. Headings are 32 px or more, so this bounds them too.
  const bound = Math.ceil(el.clientHeight / 32) + 1 + 20;
  metric("u07_rendered_bound", bound);
  const loafs = loaf?.stop();
  if (loafs !== undefined) {
    metric("u07_scroll_loaf_count", loafs.length);
    metric("u07_scroll_loaf_max_ms", Math.max(0, ...loafs));
  }
  const tasks = longtask?.stop();
  if (tasks !== undefined) {
    metric("u07_scroll_longtask_count", tasks.length);
    metric("u07_scroll_longtask_max_ms", Math.max(0, ...tasks));
  }
  const pass = frames.p95 <= TARGETS.frameP95Ms && maxRendered <= bound;
  metric("u07_scroll_pass", pass);
  record(
    "u07 scroll",
    `${pass ? "pass" : "fail"} p95 ${frames.p95.toFixed(1)} ms, ${String(maxRendered)} rendered`,
  );
}

async function viewSwitches(h: Harness, count: number): Promise<void> {
  const el = h.handle.scroller;
  const work: number[] = [];
  const derive: number[] = [];
  const painted: number[] = [];
  for (let i = 0; i < count; i++) {
    if (el !== null) el.scrollTop = 0;
    await afterPaint();
    const target: ViewName = h.view() === "area" ? "due" : "area";
    const t0 = now();
    derive.push(h.switchView(target));
    work.push(now() - t0);
    painted.push((await afterPaint()) - t0);
  }
  put("u07_switch_derive", stats(derive));
  put("u07_switch_work", stats(work));
  const paint = stats(painted);
  put("u07_switch_paint", paint);
  const pass = paint.p95 <= TARGETS.viewSwitchMs;
  metric("u07_switch_pass", pass);
  metric("u07_switch_margin", TARGETS.viewSwitchMs / Math.max(0.01, paint.p95));
  record("u07 view switch", `${pass ? "pass" : "fail"} p95 ${paint.p95.toFixed(1)} ms`);
}

async function bursts(h: Harness, count: number, size: number): Promise<void> {
  const el = h.handle.scroller;
  if (el !== null) el.scrollTop = el.scrollHeight / 2;
  await afterPaint();
  await afterPaint();
  const random = rng(4242);
  const work: number[] = [];
  const derive: number[] = [];
  const painted: number[] = [];
  // Each burst is applied inside a rAF callback. The interval to the next rAF callback covers the
  // whole frame: the burst's script work plus the style, layout and paint it causes. A frame that
  // overruns the budget shows as an interval of two refresh periods or more.
  const frames: number[] = [];
  const idle: number[] = [];
  const loaf = observe("long-animation-frame");
  for (let i = 0; i < count; i++) {
    const events = makeBurst(random, size, h.liveIds(), h.handle.visibleTaskIds);
    // An idle frame first, as the baseline interval of this browser and display.
    const before = await nextFrame();
    const start = await nextFrame();
    idle.push(start - before);
    const t0 = now();
    derive.push(h.applyBurst(events));
    work.push(now() - t0);
    const next = await nextFrame();
    frames.push(next - start);
    // From the burst to the start of the next frame: the burst's frame has been produced.
    painted.push(next - t0);
  }
  put("u07_burst_derive", stats(derive));
  const w = stats(work);
  put("u07_burst_work", w);
  put("u07_burst_to_next_frame", stats(painted));
  const f = stats(frames);
  put("u07_burst_frame", f);
  put("u07_burst_idle_frame", stats(idle));
  const loafs = loaf?.stop();
  if (loafs !== undefined) {
    metric("u07_burst_loaf_count", loafs.length);
    metric("u07_burst_loaf_max_ms", Math.max(0, ...loafs));
  }
  metric("u07_burst_events", size);
  // A5 3.25: <= 16 ms of main-thread work per frame, judged on every burst (the maximum): the
  // script work stays under 16 ms and the frame that holds the burst is not late.
  const pass = w.max <= TARGETS.burstWorkMs && f.max <= TARGETS.frameP95Ms;
  metric("u07_burst_pass", pass);
  metric("u07_burst_margin", TARGETS.burstWorkMs / Math.max(0.01, w.max));
  record(
    "u07 burst",
    `${pass ? "pass" : "fail"} work max ${w.max.toFixed(1)} ms, frame max ${f.max.toFixed(1)} ms`,
  );
}

interface MemoryInfo {
  usedJSHeapSize: number;
}

function heap(): number | undefined {
  const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
  return memory === undefined ? undefined : memory.usedJSHeapSize / (1024 * 1024);
}

export async function runU07(h: Harness, params: URLSearchParams): Promise<void> {
  const step = Number(params.get("step") ?? 156);
  const switches = Number(params.get("switches") ?? 20);
  const burstCount = Number(params.get("bursts") ?? 20);
  record("u07", "running");
  hidden = document.visibilityState !== "visible";
  metric("u07_tasks", h.liveIds().length);
  metric("u07_hardware_threads", navigator.hardwareConcurrency);
  metric("u07_device_pixel_ratio", window.devicePixelRatio);
  const before = heap();
  if (before !== undefined) metric("u07_heap_before_mb", before);
  await scrollThrough(h, step);
  await viewSwitches(h, switches);
  await bursts(h, burstCount, 100);
  const after = heap();
  if (after !== undefined) {
    metric("u07_heap_after_mb", after);
    metric("u07_heap_pass", after <= TARGETS.heapMb);
  }
  metric("u07_hidden_during_run", hidden);
  metric("u07_done", true);
  record("u07", hidden ? "done, but the page was hidden during the run" : "done");
  await report("u07");
}

/** Time from navigation start to the first painted list (an indication for "Today interactive"). */
export async function firstList(): Promise<void> {
  const painted = await afterPaint();
  metric("u07_first_list_ms", painted);
  metric("u07_first_list_pass", painted <= TARGETS.firstListMs);
}
