// pnpm phone-emulator --app <apk> --test <apk>: the phone app on a running Android emulator against
// the real service in this process, counted on the computer's side of the link.
//
// 1. A pairing code from Settings > Phones goes to the emulator as a file, never on a command line.
// 2. Inside the installed app (apps/phone/android-test), a wrong pin fails the handshake: the phone
//    reaches the listener's port and makes no upgrade, so it sent nothing of its own.
// 3. The right pin and the code: one upgrade, one paired phone, and the app keeps the pairing.
// 4. The app is force-stopped and started as a person starts it: it opens the link again without a
//    code, the computer serves it, and the screen shows the space and Connected.
//
// The emulator reaches this computer's loopback as 10.0.2.2, so that is the code's address. Fixture
// data only. It exits with 0 when every step held and 1 at the first that did not.
import "../../packages/bridge/src/safe-exit.ts";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Server } from "node:https";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ANDROID_APP_ID } from "../../packages/brand/src/index.ts";
import { post } from "../../packages/service/test/http-client.ts";
import { httpWorld, signIn } from "../../packages/service/test/http-world.ts";

const { values } = parseArgs({
  options: { app: { type: "string" }, test: { type: "string" } },
  strict: true,
});
if (values.app === undefined || values.test === undefined) {
  console.error("usage: pnpm phone-emulator --app <apk> --test <apk>");
  process.exit(2);
}
const { app, test } = values;

const PAIRING_FILE = "/data/local/tmp/ttasks-pairing.txt";
const RUNNER = `${ANDROID_APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`;

// What reaches the listener, counted where it arrives: a TCP connection and a WebSocket upgrade.
const seen = { connections: 0, upgrades: 0 };
// eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the server as `this`
const emit = Server.prototype.emit;
Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
  if (event === "connection") seen.connections += 1;
  if (event === "upgrade") seen.upgrades += 1;
  return emit.call(this, event, ...args);
} as typeof emit;
const reset = () => {
  seen.connections = 0;
  seen.upgrades = 0;
};

const adb = (...args: string[]): string =>
  execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function check(holds: boolean, what: string): void {
  console.log(`${holds ? "ok  " : "FAIL"} ${what}`);
  if (!holds) throw new Error(what);
}

/** Runs one method of the installed app's LinkTest. */
function instrument(method: string): boolean {
  const out = adb(
    "shell",
    "am",
    "instrument",
    "-w",
    "-e",
    "class",
    `${ANDROID_APP_ID}.LinkTest#${method}`,
    RUNNER,
  );
  const passed = out.includes("OK (1 test)");
  if (!passed) console.log(out);
  return passed;
}

/** Waits for `holds`, asking every half second, for at most `ms`. */
async function until(holds: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await holds())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}

const world = await httpWorld("phone-emulator", {
  link: { host: "127.0.0.1", ports: [0], addresses: () => ["10.0.2.2"] },
});
let failed = false;
try {
  const { token } = await signIn(world);
  const machine = async (action: string, body: unknown) => {
    const reply = await post(world.port(), `/api/v1/machine/${action}`, body, { token });
    return (JSON.parse(reply.body) as { result: Record<string, unknown> }).result;
  };
  const phones = async () =>
    (await machine("phones", {}))["phones"] as { name: string; last_used_at: string | null }[];

  adb("install", "-r", app);
  adb("install", "-r", test);

  const made = await machine("phone_pair", { space: "Mira" });
  const file = join(world.root, "pairing.txt");
  writeFileSync(file, made["code"] as string, { mode: 0o600 });
  adb("push", file, PAIRING_FILE);

  reset();
  check(instrument("wrongPin"), "a wrong pin fails the handshake on the pin");
  check(seen.connections > 0, `the phone reached the listener (${String(seen.connections)} TCP)`);
  check(seen.upgrades === 0, `and made no upgrade (${String(seen.upgrades)})`);

  reset();
  check(instrument("pairs"), "the right pin and the code get the hello for the space");
  check(seen.upgrades === 1, `one upgrade (${String(seen.upgrades)})`);
  const paired = await phones();
  check(paired.length === 1 && paired[0]?.name === "Emulator", "one phone is paired, by its name");
  const before = paired[0]?.last_used_at;

  adb("shell", "am", "force-stop", ANDROID_APP_ID);
  reset();
  adb("shell", "am", "start", "-W", "-n", `${ANDROID_APP_ID}/.MainActivity`);
  // The computer touches a phone it serves.
  check(
    await until(async () => (await phones())[0]?.last_used_at !== before, 120_000),
    `the started app was served again without a code (${String(seen.upgrades)} upgrade)`,
  );
  check(
    await until(() => {
      adb("shell", "uiautomator", "dump", "/sdcard/ttasks-ui.xml");
      const xml = adb("shell", "cat", "/sdcard/ttasks-ui.xml");
      return xml.includes('text="Mira"') && xml.includes('text="Connected"');
    }, 60_000),
    "the screen shows the space and Connected",
  );
  check((await phones()).length === 1, "still one paired phone");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  try {
    adb("shell", "rm", "-f", PAIRING_FILE);
  } catch {
    // The emulator is thrown away with the job.
  }
  await world.close();
}
process.exit(failed ? 1 : 0);
