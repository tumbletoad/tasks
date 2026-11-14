// Entry of the spike page (step M0.08). Order matters: the CSP listener first, so no violation is
// missed, then the list, then the session checks (U01-U04), the fonts (U05) and, with
// ?measure=u07, the U07 measurement once the session works.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fira-code/wght.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { checkFonts } from "./fonts.ts";
import { record, report } from "./report.ts";
import { bootstrap, watchCsp, watchShortcuts } from "./session.ts";

watchCsp();
watchShortcuts();

const params = new URLSearchParams(location.search);
const measure = params.get("measure") === "u07" ? params : null;
const container = document.getElementById("root");
if (container === null) throw new Error("no #root");
const root = createRoot(container);
root.render(<App ready={false} measure={measure} />);

async function start(): Promise<void> {
  const session = await bootstrap();
  await checkFonts();
  await report();
  if (session) root.render(<App ready measure={measure} />);
}

start().catch((error: unknown) => {
  record("bootstrap", `fail ${error instanceof Error ? error.name : "error"}`);
  void report();
});
