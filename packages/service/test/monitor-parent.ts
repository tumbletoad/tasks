// A service stand-in for monitor.test.ts: it starts the monitor's child as the service does, says
// "ok" once the first answer came, and waits to be killed. Run as `node monitor-parent.ts <file>
// <args>...`, the fake `ttam`'s program and arguments.
import { Monitor } from "../src/monitor/index.ts";

const [file = "", ...args] = process.argv.slice(2);
const monitor = new Monitor({
  command: () => Promise.resolve({ ok: true, file, args, env: process.env, cwd: process.cwd() }),
});
const answer = await monitor.ask();
process.stdout.write(`${answer.ok ? "ok" : "failed"}\n`);
// It never outlives its test by long, should the test not kill it: with its child ended, nothing
// keeps it running.
setTimeout(() => void monitor.close(), 120_000);
