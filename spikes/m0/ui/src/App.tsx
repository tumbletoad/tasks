// The spike page: the U07 list on the left, the lab panel for U01-U06 on the right. Lab code for
// step M0.08, not the product UI: no router and no i18n catalogue. One React Aria button checks
// React Aria's nonce plumbing.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { flushSync } from "react-dom";
import {
  applyEvents,
  deriveView,
  makeFixture,
  rng,
  type Item,
  type Task,
  type ViewName,
} from "./data.ts";
import { List, type ListHandle } from "./List.tsx";
import { firstList, runU07, type Harness } from "./measure.ts";
import { allChecks, allMetrics, snapshotVersion, subscribe } from "./report.ts";
import { copyFixture, observe, reveal, revealTargets } from "./session.ts";

export const TASK_COUNT = 5000;
const fixture = makeFixture(TASK_COUNT);

interface State {
  tasks: readonly (Task | undefined)[];
  view: ViewName;
  items: readonly Item[];
}

function Results(): ReactNode {
  useSyncExternalStore(subscribe, snapshotVersion);
  const checks = allChecks();
  const metrics = allMetrics().filter(([name]) => name.endsWith("_pass") || name.endsWith("_p95"));
  return (
    <ul className="results">
      {checks.map(([name, value]) => (
        <li
          key={name}
          className={
            value.startsWith("ok") || value.startsWith("pass")
              ? "ok"
              : value.startsWith("fail")
                ? "fail"
                : ""
          }
        >
          <span>{name}</span> {value}
        </li>
      ))}
      {metrics.map(([name, value]) => (
        <li key={name} className="metric">
          <span>{name}</span> {typeof value === "number" ? value.toFixed(2) : String(value)}
        </li>
      ))}
    </ul>
  );
}

const QUESTIONS = [
  ["lna prompt", "A Local Network Access prompt appeared (U03)"],
  ["link new tab", "The https: link opened in a new tab (U06)"],
  ["reveal opened", "Reveal opened the file manager (U06)"],
  ["install offered", "The browser offered to install the app (U01, U02)"],
] as const;

function LabPanel({ ready, onMeasure }: { ready: boolean; onMeasure: () => void }): ReactNode {
  const [targets, setTargets] = useState<{ index: number; label: string }[]>([]);
  useEffect(() => {
    if (ready) void revealTargets().then(setTargets);
  }, [ready]);
  return (
    <aside className="lab" aria-label="Lab panel">
      <p className="hint">
        Fixture space Mira. Press <kbd>/</kbd>, <kbd>Ctrl+K</kbd>, <kbd>Ctrl+Enter</kbd> or{" "}
        <kbd>Ctrl+Shift+Enter</kbd> to check the shortcuts (U04).
      </p>
      <div className="actions">
        {/* A React Aria button: its press style element must carry the nonce (A5 section 5). */}
        <AriaButton className="aria-button" onPress={() => void copyFixture()}>
          Copy fixture text
        </AriaButton>
        <a href="https://example.org/" target="_blank" rel="noopener noreferrer">
          Open an https: link
        </a>
        {targets.map((target) => (
          <button
            key={target.index}
            type="button"
            onClick={() => void reveal(target.index, target.label)}
          >
            Reveal {target.label}
          </button>
        ))}
        <button type="button" onClick={onMeasure}>
          Run the U07 measurement
        </button>
      </div>
      <dl className="questions">
        {QUESTIONS.map(([key, text]) => (
          <div key={key}>
            <dt>{text}</dt>
            <dd>
              <button type="button" onClick={() => void observe(key, "yes")}>
                Yes
              </button>
              <button type="button" onClick={() => void observe(key, "no")}>
                No
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <p id="font-ui" className="font-sample">
        Inter: Mira fixture M-14 · 0123456789
      </p>
      <p id="font-mono" className="font-sample mono">
        Fira Code: ~/Tasks/mira -&gt; M-14 != 0x1f
      </p>
      <p id="style-probe">Style probe</p>
      <Results />
    </aside>
  );
}

export function App({
  ready,
  measure,
}: {
  ready: boolean;
  measure: URLSearchParams | null;
}): ReactNode {
  const [state, setState] = useState<State>(() => ({
    tasks: fixture.tasks,
    view: "area",
    items: deriveView(fixture.tasks, "area"),
  }));
  const current = useRef(state);
  current.current = state;
  const handle = useRef<ListHandle>({ scroller: null, rendered: 0, visibleTaskIds: [] }).current;
  const firstCommit = useRef(false);
  const running = useRef(false);
  const random = useRef(rng(7)).current;

  const harness: Harness = {
    handle,
    view: () => current.current.view,
    liveIds: () => current.current.tasks.flatMap((task) => (task === undefined ? [] : [task.id])),
    switchView(view) {
      const t0 = performance.now();
      const items = deriveView(current.current.tasks, view);
      const derive = performance.now() - t0;
      const next = { tasks: current.current.tasks, view, items };
      flushSync(() => {
        setState(next);
      });
      current.current = next;
      return derive;
    },
    applyBurst(events) {
      const t0 = performance.now();
      const tasks = applyEvents(random, current.current.tasks, events, fixture.projects);
      const items = deriveView(tasks, current.current.view);
      const derive = performance.now() - t0;
      const next = { tasks, view: current.current.view, items };
      flushSync(() => {
        setState(next);
      });
      current.current = next;
      return derive;
    },
  };

  const startMeasure = (params: URLSearchParams) => {
    if (running.current) return;
    running.current = true;
    void runU07(harness, params).finally(() => {
      running.current = false;
    });
  };

  // The measurement starts once, when the session checks are done.
  useEffect(() => {
    if (ready && measure !== null) startMeasure(measure);
  }, [ready]);

  const taskCount = state.items.reduce((n, item) => (item.kind === "task" ? n + 1 : n), 0);
  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Tasks M0 spike</span>
        <nav className="views" aria-label="Views">
          {(["area", "due"] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={state.view === view}
              onClick={() => {
                harness.switchView(view);
              }}
            >
              {view === "area" ? "By area" : "By due date"}
            </button>
          ))}
        </nav>
      </header>
      <main className="main">
        <List
          items={state.items}
          areas={fixture.areas}
          projects={fixture.projects}
          grouped={state.view === "area"}
          taskCount={taskCount}
          handle={handle}
          onCommit={() => {
            if (firstCommit.current) return;
            firstCommit.current = true;
            void firstList();
          }}
        />
        <LabPanel
          ready={ready}
          onMeasure={() => {
            startMeasure(new URLSearchParams());
          }}
        />
      </main>
    </div>
  );
}
