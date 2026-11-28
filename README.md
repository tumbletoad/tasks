# TTasks

TTasks, by TumbleToad, is an agent-first task app. It is a calm task list that agents keep up to date, a library of what is known about the work that agents keep current, and a launch pad that sends each task to the right agent app, in the right folder, with the right account.

A space is one tree of projects and tasks, and knowledge pages, sources and notes can sit at any level of it, so what one task learned is found by the next. An agent that opens a task is handed what is known above it. [The product vision](VISION.md) describes the experience we are building toward.

Website: [tumbletoad.com/tasks](https://tumbletoad.com/tasks)

## Status

In development. There is no release yet: you build and run it from source. What you can use today: the page with its views (Today, Inbox, Open, Waiting, Review, Backlog, Completed, Agents), areas and projects, search, the expanded task with its thread, and undo and redo; opening a task in Claude Code, Codex or T3 Code, in its folder, and background runs of an agent on a task; the `ttasks` command line, and the MCP endpoint that agents use, which `ttasks setup agents` connects for Claude Code and Codex; storage with its migrations and verified backups, and `ttasks update --from <archive>`. Knowledge pages, nested projects, routines and the phone app are planned: [`planning/PLAN.md`](planning/PLAN.md) has the steps and [`planning/STATUS.md`](planning/STATUS.md) their state.

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
| `pnpm accept m<N>` | The acceptance tests of milestone N of the earlier plan. `--installed <root>` runs them against an installed build |
| `pnpm release` | Release key and signing (`keygen`, `sign`), for the holder of the release key. A release itself is made by its version tag: `.github/workflows/release.yml` |
| `pnpm node-version` | Prints the Node version pnpm runs the project with |

## Where things live

- [`VISION.md`](VISION.md): the intended experience, mood and character.
- [`planning/PLAN.md`](planning/PLAN.md): what the product becomes and the steps there.
- [`planning/STATUS.md`](planning/STATUS.md): the state of each step.
- [`docs/promises-and-limits.md`](docs/promises-and-limits.md): what a person can count on, and where the protection stops.
- [`docs/agents/`](docs/agents/): the agent tools and the command line's verbs, generated from `packages/contracts`.
- [`docs/protocol/ttasks-local-1.md`](docs/protocol/ttasks-local-1.md): the local protocol between the service and its clients.
- [`skills/`](skills/): the skills TTasks gives agents.
- [`AGENTS.md`](AGENTS.md): how to work on the code, for people and coding agents alike.

## Licence

TTasks is source-available under the Sustainable Use License 1.0. You may use it and change it for your own internal business purposes and for personal or non-commercial use, and you may run it yourself. You may pass it on only free of charge and for non-commercial purposes: selling it, or offering it to others as a paid product or service, is not allowed. [`LICENSE`](LICENSE) holds the terms, and they are what counts; see also [`NOTICE`](NOTICE).

Versions up to and including commit `67830a97` (27 November 2026) were published under the Apache License 2.0 and remain available under it.

Contributions are welcome. Before a first contribution is merged, you are asked to agree that the project may license it under these and other terms.
