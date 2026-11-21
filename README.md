# TTasks

TTasks, by TumbleToad, is an agent-first task app. It is a calm task list that agents keep up to date, and a launch pad that sends each task to the right agent app, in the right folder, with the right account. Inside the app it is called TTasks.

You see what matters, open a task with the agent you choose, and come back to a clear account of what changed, what needs you and what comes next. The aim is less time maintaining a system and more attention for the work itself. [The product vision](VISION.md) describes the experience we are building toward.

Website: [tumbletoad.com/tasks](https://tumbletoad.com/tasks)

## Status

In development, not yet usable. There is no release yet. In place: storage with its migrations and verified backups, the service, the local protocol, the CLI, the MCP endpoint with session binding, `ttasks setup agents` for Claude Code and Codex, the launch routes for Claude Code, Codex and T3 Code, the build, test installs and `ttasks update --from <archive>`. The browser UI has its shell, live updates and the task list. The views, the expanded task, undo, search and background runs are being built. Step states are in [`planning/STATUS.md`](planning/STATUS.md).

TTasks is developed and checked on Windows 11 and on Ubuntu 24.04 without sudo rights. CI runs on Ubuntu and Windows. macOS is build-only until someone verifies it on a Mac.

## Build and check

You need [pnpm](https://pnpm.io) 12.18.0. pnpm downloads and verifies the pinned Node 26.13.1 itself, so no system Node is needed. Run every command through pnpm.

`pnpm verify` also needs `gpgv`, which checks the Node releasers' signature in the build tests. Ubuntu ships it, and on Windows the copy in Git for Windows is used. On Windows the tests build the C launchers, which needs Visual Studio 2022 or its Build Tools with the x64 C++ tools and a Windows 10 or 11 SDK (`packages/launcher-win/README.md`).

```sh
pnpm install
pnpm verify
```

| Command | Does |
|---|---|
| `pnpm verify` | The one check: generated-file freshness, typecheck, lint, dependency rules, the test manifest and the tests |
| `pnpm e2e` | The browser tests against a real service, in Chromium and Firefox (`--project` picks one). Needs `pnpm exec playwright install chromium firefox` once. Not part of `pnpm verify` |
| `pnpm gen` | Regenerates `packages/contracts/generated/` and the generated docs |
| `pnpm ttasks <args>` | Runs the CLI from source. `pnpm ttasks serve` serves the page from `packages/web/dist` once `pnpm build:web` has built it |
| `pnpm seed --out <folder>` | Builds the sample space from fixture data |
| `pnpm crash --minutes <n>` | Crash-injection harness |
| `pnpm build:web` | Builds the browser page into `packages/web/dist` |
| `pnpm build` | Version folder, archive and `SHA256SUMS` in `dist/` (needs the network). `--sign test` signs with a throwaway key and writes test install scripts |
| `pnpm smoke --dist <folder> --work <new folder>` | Installs a test-signed build into a separate root through each signature verifier and checks that tampered downloads are refused |
| `pnpm accept m<N>` | A milestone's acceptance script. `--installed <root>` runs it against an installed build |
| `pnpm release` | Release key and signing (`keygen`, `sign`), for the holder of the release key. A release itself is made by its version tag: `.github/workflows/release.yml` |
| `pnpm node-version` | Prints the Node version pnpm runs the project with |

## Where things live

- [`VISION.md`](VISION.md): the intended experience, mood and character.
- [`planning/PLAN.md`](planning/PLAN.md): the plan, with the specifications A1 to A7 in `planning/appendix/`. The steps are in A7.
- [`planning/STATUS.md`](planning/STATUS.md): the state of every step.
- [`AGENTS.md`](AGENTS.md): how to work on the code, for people and coding agents alike.

## Licence

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
