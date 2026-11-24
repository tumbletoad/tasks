// The service's agent-home rows as setup's tests keep them: a grants table of the test's own, so a
// test sees what setup gave and took back and when, and can make the service refuse.
import { GrantRefused, samePath, type Access, type AgentHome } from "../src/setup/index.ts";

export interface KeptRow {
  readonly app: string;
  readonly home: string;
  readonly instance: string;
  readonly space: string;
  readonly grant: string;
}

export interface KeptRows extends Access {
  /** The live rows. */
  readonly live: KeptRow[];
  /** Each call as it came: `grant` or `revoke`, with the home's folder. */
  readonly asked: { readonly verb: "grant" | "revoke"; readonly home: string }[];
  /** What the service does with the next calls: refuse a grant, or fail a revoke or a read. */
  refuse: { grant?: "instance_taken" | "grant_failed"; revoke?: boolean; read?: boolean };
}

/** A grants table that gives each home one row, as the service does. `before` sees each call first. */
export function keptRows(before?: (verb: "grant" | "revoke", home: AgentHome) => void): KeptRows {
  let made = 0;
  const live: KeptRow[] = [];
  const ofHome = (home: AgentHome) => (row: KeptRow) =>
    row.app === home.app && samePath(process.platform, row.home, home.home);
  const rows: KeptRows = {
    live,
    asked: [],
    refuse: {},
    grant(home, space) {
      rows.asked.push({ verb: "grant", home: home.home });
      before?.("grant", home);
      if (rows.refuse.grant !== undefined)
        return Promise.reject(new GrantRefused(rows.refuse.grant));
      const kept = live.find(
        (row) => ofHome(home)(row) && row.instance === home.instance && row.space === space,
      );
      if (kept !== undefined) return Promise.resolve(kept.grant);
      for (let i = live.length - 1; i >= 0; i -= 1) {
        if (ofHome(home)(live[i] as KeptRow)) live.splice(i, 1);
      }
      made += 1;
      const grant = `gr_${String(made).padStart(26, "0")}`;
      live.push({ app: home.app, home: home.home, instance: home.instance, space, grant });
      return Promise.resolve(grant);
    },
    read(home) {
      if (rows.refuse.read === true) return Promise.reject(new Error("service gone"));
      const row = live.find(ofHome(home));
      return Promise.resolve(row === undefined ? null : { grant: row.grant });
    },
    revoke(home) {
      rows.asked.push({ verb: "revoke", home: home.home });
      before?.("revoke", home);
      if (rows.refuse.revoke === true) return Promise.reject(new Error("service gone"));
      for (let i = live.length - 1; i >= 0; i -= 1) {
        if (ofHome(home)(live[i] as KeptRow)) live.splice(i, 1);
      }
      return Promise.resolve();
    },
  };
  return rows;
}
