# M0.07 lifecycle lab

Lab code for lab run S and E (A7 3.7, step M0.07): service lifecycle, process placement and the agent environment. It is never shipped and is thrown away after M0, like the kit (`../README.md`). Results are kept outside the repository (A7 3.7). Session 3 (reboots and sign-in) runs with the product's service install (M1.12), in lab session 3 (A7 3.7).

## What is here

| File | What |
|---|---|
| `entry.ts` | The lab release's `lib/ttasks.mjs`: routes `service`, `call`, `open`, `ticket`, `run-shim`, `accounts`, `tree` to the kit, `mcp` to the forwarder, `shim` to the stand-in shim, `ttasksw.exe` with no arguments (or `supervise`) to the supervisor, and `version`, `wait`, `gate`, `install` as the packaging spike does |
| `supervisor.ts` | A Node stand-in for the `ttasksw.exe` supervisor loop of A2 3.3.2, which the spike's C launcher does not have. Exit 0, 64, 73: stop. 75: start again at once, re-reading `current`. Other: restart after 1, 2, 4, 8 s; the 5th crash in 10 minutes writes `<state>\crash\supervisor-gave-up.json` and stops. Events go to `<root>\state\supervisor.jsonl` |
| `build.ts` | `buildLab(out)`: the kit and the lab sources as `.mjs` (`<out>/kit/`, `<out>/lifecycle/`). `assembleLabFolder`: a packaging-spike version folder turned into a lab release (entry, supervisor and kit added, `manifest.json` written again, launchers and Node unchanged) |
| `make-release.ts` | Builds the lab releases `0.0.7-lab.a` and `0.0.7-lab.b` for the stages given (win-x64, linux-x64), packs them and signs them with a throwaway key: install them with the packaging spike's `install.ps1` and `install.sh` |
| `lab.ts` | The harness: `s04`, `s06`, `s07`, `s08`, `s09`, `e01`, `accounts` (S12), and the helpers `s01` (the S01 pre-test in a transient unit) and `s03-crash` (the S03 pre-test of the supervisor stand-in). Each writes one result file: numbers, yes or no, exit codes, version labels and tool names only |
| `cold-start.ps1`, `cold-start.sh` | Session 3: the cold-after-reboot timing of B01, B06 and B07 without Node in the timing process (Windows PowerShell or POSIX sh). After the clock stops, both replies are checked by their JSON structure (the sh timer validates with the install's Node only after every timed launch of its run), and a measurement counts only when the bridge's own `status` shows the expected kind of answer. A stale `service.json`, or one naming a process with another entry, is not a running service. Every process they start is stopped, also on a failure |
| `lifecycle.test.ts` | The self-test, `[A7.3.7.m0-lifecycle.self-test]` |
| `cold-start.test.ts` | The timers' self-test, with E01's cleanup, `[A7.3.7.m0-session3.cold-start]` |

## Running it

On Windows, from the repository:

```
pnpm exec node spikes/m0/packaging/scripts/build.ts --platform win-x64 --work <s>\build-win --dist <s>\dist-base
pnpm exec node spikes/m0/packaging/scripts/build.ts --platform linux-x64 --work <s>\build-linux --dist <s>\dist-base
pnpm exec node spikes/m0/lifecycle/make-release.ts --stage <s>\build-win\stage\0.0.0-spike --stage <s>\build-linux\stage\0.0.0-spike --work <s>\lab-work --dist <s>\dist --key <s>\key
powershell -NoProfile -ExecutionPolicy Bypass -File <s>\dist\install-0.0.7-lab.a.ps1 -Source <s>\dist -Root <s>\inst
<s>\inst\versions\0.0.7-lab.a\runtime\node.exe <s>\lab-work\lab-js\lifecycle\lab.mjs <row> ... --out <file>
```

`<s>` is a new scratch folder. On Linux the same `lab-js` folder and the linux archives go to a scratch folder of their own and install with `sh install-0.0.7-lab.a.sh --source dist --root <root>`; the harness runs on `<root>/versions/0.0.7-lab.a/runtime/node`.

## What the lab code does not cover

- Spaces: the kit has none. S09's "the test install cannot open the daily spaces" is checked at the service lock (a test-install service on the daily state folder exits 73).
- The supervisor is Node, not C: the S03 pre-test's restart policy is the stand-in's (A2 3.3.2), and a `taskkill /F` must name the service's PID, never `node.exe` by image name. Session 3 uses M1.11's `ttasksw.exe`.
- Resume handles and the offline cache file in the forwarder (A2 3.7.3, 3.7.5).
