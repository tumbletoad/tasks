// Builds the page once per `pnpm e2e` run, the way the version folder gets it (packages/web's
// buildWeb), into a temporary folder of this run, removed by its full name at the end. Workers find
// it in E2E_UI_BUILD.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWeb } from "../../packages/web/build.ts";

export default async function globalSetup(): Promise<() => void> {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-e2e-ui-")));
  await buildWeb(join(folder, "ui"));
  process.env["E2E_UI_BUILD"] = join(folder, "ui");
  return () => {
    rmSync(folder, { recursive: true, force: true });
  };
}
