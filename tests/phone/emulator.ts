// pnpm phone-emulator --app <apk> --test <apk> [--shots <folder>]: the phone app on a running
// Android emulator against the real service in this process, counted on the computer's side of the
// link; with --shots, a picture of each state the screen reaches, for the pull request.
//
// 1. A pairing code from Settings > Phones goes to the emulator as a file, never on a command line.
// 2. Inside the installed app (apps/phone/android-test), a wrong pin fails the handshake: the phone
//    reaches the listener's port and makes no upgrade, so it sent nothing of its own.
// 3. The screen a person meets: Scan the code, the code read (handed to the open scanner from inside
//    the app, as an emulator has no camera to see it), the phone named, Pair, Connected: one phone,
//    by its name.
// 4. The app is force-stopped and started as a person starts it: it opens the link again without a
//    code, the computer serves it, and the screen shows the space and Connected. Sent to the
//    background and brought back, it opens the link again.
// 5. The phone is removed on the computer. Started again, the app is told so, forgets the pairing
//    and offers to scan a code; started once more, it is not paired and opens no connection.
//
// The emulator reaches this computer's loopback as 10.0.2.2, so that is the code's address. Fixture
// data only. It exits with 0 when every step held and 1 at the first that did not.
import "../../packages/bridge/src/safe-exit.ts";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Server } from "node:https";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { ANDROID_APP_ID } from "../../packages/brand/src/index.ts";
import { post } from "../../packages/service/test/http-client.ts";
import { httpWorld, signIn } from "../../packages/service/test/http-world.ts";

const { values } = parseArgs({
  options: { app: { type: "string" }, test: { type: "string" }, shots: { type: "string" } },
  strict: true,
});
if (values.app === undefined || values.test === undefined) {
  console.error("usage: pnpm phone-emulator --app <apk> --test <apk>");
  process.exit(2);
}
const { app, test, shots } = values;
// adb pull writes only into a folder that is there.
if (shots !== undefined) mkdirSync(shots, { recursive: true });

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

// Never synchronous: the service answering the emulator runs in this process.
const run = promisify(execFile);
const adb = async (...args: string[]): Promise<string> =>
  (await run("adb", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;

/** A picture of the screen as it is, for the pull request, when `--shots` names a folder. */
async function shot(name: string): Promise<void> {
  if (shots === undefined) return;
  const png = await run("adb", ["exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(join(shots, `${name}.png`), png.stdout);
}

function check(holds: boolean, what: string): void {
  console.log(`${holds ? "ok  " : "FAIL"} ${what}`);
  if (!holds) throw new Error(what);
}

/** Runs one method of the installed app's LinkTest. */
async function instrument(method: string): Promise<boolean> {
  const out = await adb(
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
    (await machine("phones", {}))["phones"] as {
      id: string;
      name: string;
      last_used_at: string | null;
    }[];
  const restart = async () => {
    await adb("shell", "am", "force-stop", ANDROID_APP_ID);
    reset();
    await adb("shell", "am", "start", "-W", "-n", `${ANDROID_APP_ID}/.MainActivity`);
  };
  const shows = (...texts: string[]) =>
    until(async () => {
      await adb("shell", "uiautomator", "dump", "/sdcard/ttasks-ui.xml");
      const xml = await adb("shell", "cat", "/sdcard/ttasks-ui.xml");
      return texts.every((text) => xml.includes(`text="${text}"`));
    }, 60_000);

  await adb("install", "-r", app);
  await adb("install", "-r", test);
  // The scanner opens on the camera a person allows when it asks; here it is allowed beforehand.
  await adb("shell", "pm", "grant", ANDROID_APP_ID, "android.permission.CAMERA");

  const made = await machine("phone_pair", { space: "Mira" });
  const file = join(world.root, "pairing.txt");
  writeFileSync(file, made["code"] as string, { mode: 0o600 });
  await adb("push", file, PAIRING_FILE);

  reset();
  check(await instrument("wrongPin"), "a wrong pin fails the handshake on the pin");
  check(seen.connections > 0, `the phone reached the listener (${String(seen.connections)} TCP)`);
  check(seen.upgrades === 0, `and made no upgrade (${String(seen.upgrades)})`);

  reset();
  check(
    await instrument("pairsThroughTheScreen"),
    "Scan the code, the code read, the phone named, Pair: the screen says Connected",
  );
  check(seen.upgrades > 0, `the code went to the computer (${String(seen.upgrades)} upgrades)`);
  if (shots !== undefined) {
    await adb(
      "pull",
      `/sdcard/Android/data/${ANDROID_APP_ID}/files/name.png`,
      join(shots, "2-name.png"),
    );
  }
  const paired = await phones();
  check(paired.length === 1 && paired[0]?.name === "Emulator", "one phone is paired, by its name");
  const before = paired[0]?.last_used_at;

  await restart();
  // The computer touches a phone it serves.
  check(
    await until(async () => (await phones())[0]?.last_used_at !== before, 120_000),
    `the started app was served again without a code (${String(seen.upgrades)} upgrade)`,
  );
  check(await shows("Mira", "Connected"), "the screen shows the space and Connected");
  await shot("3-connected");
  check((await phones()).length === 1, "still one paired phone");

  const resumed = (await phones())[0]?.last_used_at;
  await adb("shell", "input", "keyevent", "KEYCODE_HOME");
  reset();
  await adb("shell", "am", "start", "-W", "-n", `${ANDROID_APP_ID}/.MainActivity`);
  check(
    await until(async () => (await phones())[0]?.last_used_at !== resumed, 60_000),
    `back in front, it opened the link again (${String(seen.upgrades)} upgrade)`,
  );
  check(await shows("Mira", "Connected"), "and the screen shows Connected");

  // A code that waits keeps the listener open after the last phone is removed, so the app hears it.
  await machine("phone_pair", { space: "Mira" });
  await machine("phone_remove", { phone: paired[0]?.id });
  await restart();
  check(
    await shows("This phone was removed on the computer.", "Scan the code"),
    `the started app is told it was removed (${String(seen.upgrades)} upgrade)`,
  );
  await shot("4-removed");
  await restart();
  check(
    await shows("Not paired with a computer.", "Scan the code"),
    "started again, it is not paired",
  );
  check(seen.connections === 0, `and opens no connection (${String(seen.connections)} TCP)`);
  await shot("1-not-paired");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  console.error(
    `the listener saw ${String(seen.connections)} TCP and ${String(seen.upgrades)} upgrades`,
  );
  // The app's side of what failed: the link, TLS and the test runner, not the whole log.
  const log = await adb("logcat", "-d", "-v", "brief");
  console.error(
    log
      .split("\n")
      .filter((line) =>
        /ttasks|okhttp|ssl|tls|conscrypt|keystore|TestRunner|AndroidRuntime/iu.test(line),
      )
      .slice(-200)
      .join("\n"),
  );
} finally {
  try {
    await adb("shell", "rm", "-f", PAIRING_FILE);
  } catch {
    // The emulator is thrown away with the job.
  }
  await world.close();
}
process.exit(failed ? 1 : 0);
