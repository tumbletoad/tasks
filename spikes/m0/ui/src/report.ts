// The page's results: named checks (short text) and metrics (numbers and booleans). Each change
// is shown on the page and posted to the stand-in service's /api/v1/spike/report, so the lab reads
// them from the service's events.jsonl instead of screenshots. Fixture values only: never a token,
// a code or task text.

export type Metric = number | boolean;

const checks = new Map<string, string>();
const metrics = new Map<string, Metric>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const snapshotVersion = () => version;

export function allChecks(): [string, string][] {
  return [...checks];
}

export function allMetrics(): [string, Metric][] {
  return [...metrics];
}

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

export function record(name: string, value: string): void {
  checks.set(name, value);
  changed();
}

export function metric(name: string, value: Metric): void {
  metrics.set(name, typeof value === "number" ? Math.round(value * 100) / 100 : value);
  changed();
}

export function token(): string | null {
  try {
    return localStorage.getItem("tasks.token");
  } catch {
    return null;
  }
}

export function api(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const stored = token();
  if (stored !== null) headers["authorization"] = `Bearer ${stored}`;
  return fetch(path, { ...options, headers });
}

/** Posts every result so far. `run` labels a measurement run (U07). */
export async function report(run?: string): Promise<boolean> {
  try {
    const res = await api("/api/v1/spike/report", {
      method: "POST",
      body: JSON.stringify({
        checks: Object.fromEntries(checks),
        metrics: Object.fromEntries(metrics),
        ...(run === undefined ? {} : { run }),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
