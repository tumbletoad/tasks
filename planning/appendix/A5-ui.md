# Appendix A5: UI and UX

Covers the views, the task row, the expanded task, the composer, field editing, themes, keyboard, live updates, first-run setup, the frontend stack and the static mockup (`A5-mockup.html`). Terms follow PLAN.md section Q. Examples use the synthetic fixture (Mira Okafor, Thursday 12 November 2026).

Built so far, in `packages/web`: the app shell with its routes, space per tab and default space (3.3), the task row and the virtualised list (3.6, 3.25), the live store (3.15), themes as data (3.19), the bundled fonts (3.20), the message catalogue and its lint (3.23), the build (3.24), Open and Copy through `launch.open` (3.28), the expanded task with its composer's field but not its strip (3.7, 3.8), task links with their host views (3.3), Today with its strip and sections (3.4; its digest is 3.14's), and field editing, check-off, the toast, undo and redo (3.11, 3.12). The service side the UI depends on (A2's HTTP listener, tokens and change feed) is built too. The other views, the composer's strip, search, setup and most of Settings are still to build, so those sections stay the build specification.

---

## 1. Summary

The UI is a React and TypeScript single-page app that the service serves on 127.0.0.1 (D3). It works in Firefox and Chromium, so no desktop shell is needed. One calm frame holds a sidebar of views and areas (the only place counts appear), a top bar with one search-or-add field and Refresh, and the view, which has no title. **Today** opens with a seven-day strip (the only place the date appears) and four sections in which a task appears at most once. A row shows every important action without menus. A task expands in place, with content on the left, editable facts on the right and a **composer** at the bottom whose one strip holds Note, Open per instance, Run and Copy. Agent-only text changes through agents. Every edit is an operation with a request ID, undo uses field versions, and live updates never move the focused row. Each tab shows one space. A task without a folder opens and runs in the space's **Tasks work folder**. v1 has no service worker and assumes a single-user machine. An authenticated UI origin gates the public release (M10).

---

## 2. Decisions

The IDs are cited elsewhere. Section 3 holds the detail.

| # | Choice | Where |
|---|---|---|
| U1 | The date appears only in today's cell of the week strip | 3.4 |
| U2 | Counts appear only in the sidebar, on Inbox, Open, Waiting, Review and Backlog | 3.3 |
| U3 | No view headings. The active sidebar item and the browser tab title name the view | 3.3 |
| U4 | Today: week strip, then Focus, This week, Next (3 by default), Changes, as disjoint sets | 3.4 |
| U5 | Disjoint status views (Open, Waiting, Review, Backlog) plus Inbox and Completed, so counts add up. Area views show every status | 3.5 |
| U6 | Grouping by area, then project, under small sentence-case headings with no counts | 3.5 |
| U7 | No section labels in the expanded task's left column. Short field labels stay in the facts panel | 3.7 |
| U8 | One launch tile per row with the effective instance's monogram and ring, which show the account before the click. Every pinned instance is a labelled button in the expanded task | 3.6, 3.8 |
| U9 | One composer field and one strip: Note, Open per instance, Run, Copy. No Ask verb | 3.8 |
| U10 | Hand-editable: done, star, priority, effort, due, status (with waiting-on), area and project, place, title | 3.11 |
| U11 | Agent-only: summary, context, sources, outcome, learnings. Clicking them starts a request in the composer | 3.11 |
| U12 | No notes audience toggle in v1. All notes are visible to agents (D14). The audience field stays hidden until "only me" notes ship | 3.2 |
| U13 | Check-off is final at once (D12): a 4 s struck-through hold, then the row leaves, with "Done · Undo" | 3.12 |
| U14 | Agent changes show as a dot on the row and a Changes digest on Today. The Agents view holds the full history | 3.14 |
| U15 | Sumi (dark, default), Washi (light) and System. Later themes are validated token data, never CSS, so they cannot inject CSS or break contrast silently (D17) | 3.19 |
| U16 | Bundled Inter and Fira Code, no web font requests: identical rendering on every OS, a strict CSP and tabular figures | 3.20, 3.24 |
| U17 | Vite and TanStack Router with typed search params. Every view and task has a URL | 3.3, 3.24 |
| U18 | A live store holds the open working set. TanStack Query handles details, completed pages, search and settings | 3.15, 3.24 |
| U19 | React Aria Components for controls, a custom virtualised task list | 3.24 |
| U20 | FormatJS with ICU messages. A lint rule forbids literal UI strings | 3.23 |
| U21 | Live updates apply in sequence order, batched per frame, never reordering under focus | 3.15 |
| U22 | Single-key shortcuts that can be turned off or require Alt (WCAG 2.1.4) | 3.21 |
| U23 | Priority marks: P1 outlined, P2 and P3 muted text, no mark for P4 (the default, "no priority") | 3.6 |
| U24 | Each tab holds its space in its route. A machine default space picks only what a new tab and an unbound CLI call use | 3.3 |
| U25 | Open and Run use the space's Tasks work folder for a task without a place, never a project folder (R11) | 3.8 |
| U26 | `/s/:space/task/:id` resolves a task in any lifecycle and picks a host view that shows it | 3.3 |
| U27 | No service worker in v1, a web app manifest only: a cached shell cannot be authenticated against another local user serving the same origin | 3.24, 3.26 |

---

## 3. Specification

### 3.1 Rules every screen obeys

1. **Each fact appears once on a screen.** The date, every count, the area of a row, a task on Today. An expanded task does not repeat what its header, facts and thread show. Acceptance tests check this (section 5).
2. **The screen shows work.** No captions, subtitles, eyebrows, footers, tours or starter tasks. Placeholders in empty inputs are the only instructional text. Anything genuinely unclear gets a tooltip, also shown on keyboard focus.
3. **Important actions are visible.** Check-off, star, sources, folder and launch sit on every row. In the expanded task, every agent action sits in the composer strip. No important action lives in a menu.
4. **Rows hide what their context already says.** One row function applies this everywhere (3.6).
5. **Colour means something.** Surfaces are warm neutrals. Colour marks state (due soon, late, waiting, review, live), the accent (primary action, focus) and identity (area dots). Text or shape always carries the meaning as well.
6. **Headings are small.** Section and group headings are 12.5–14 px. No text in the app is larger than 14 px. `text-transform: uppercase` is refused by the style check (3.19).
7. **Nothing moves under the pointer or focus.** Rows that leave a view wait, and live re-sorts wait until focus leaves the row.

### 3.2 Interfaces assumed from other appendices

If an owning appendix differs, the UI follows it and this section is updated.

| From | Assumed interface |
|---|---|
| A3 | The registry generates `client.ts` (`api.task.update(input)`, throwing the contracts error type) and the `contracts` types the UI imports. Every mutation takes a client-generated request ID (R3) and, for field edits, `base`: the `as_of` of the snapshot the control rendered (A1 3.5). `search` takes the CLI's query string and returns compact rows with a snapshot-bound cursor. Autonomy decides per action whether an agent change applies, applies with a mark (the changed dot), or becomes a proposal. Accepting applies each field only if its version still equals the base. Related learnings are the best three from A3's learning search. |
| A1 | Tasks have `lifecycle` (`active`, `completed`, `archived`), `status` (a key from the preference `tasks.statuses`, default open, waiting, review, backlog), an `inbox` flag, `priority` 1–4 (4 is the default and means no priority), `effort` (space scale, default S, M, L), `due_date` or `due_at` with `due_tz`, `planned_for`, `focus_on`, `waiting_on`, `position`, area, project and places. Completed tasks carry `wrap_state` (`pending`, `wrapped`) and outcome and learnings. Sources carry kind, title, person, key and URL. Notes carry an audience field that v1 always sets to `all` (D14). Undo and redo use one stack per human principal, shared by every tab and the human CLI, and return `UNDO_CONFLICT` when a field version moved. Revert offers a `dry_run` plan. Preferences are typed keys (`ui.theme`, `features.*`, `autonomy.*`) changed by undoable operations. `task.get` reads a task in any lifecycle, including a deleted task that can still be restored from Trash. A1 defines the design scale, the stress corpus and the query budgets. |
| A1, A6 | The change feed: a `snapshot`, then batches with a coverage interval against an `(epoch, incarnation, seq)` cursor (3.15). v1 never filters batches, but the client handles empty ones. |
| A2 | Built (A2 3.8). The service serves the UI and `/api` on `127.0.0.1` at a persisted port, so the origin and the installed web app stay stable. Sign-in exchanges a one-time code from the URL fragment for a bearer token in that origin's `localStorage`, with no cookies. Tokens, request checks, the CSP and the WebSocket ticket are A2's. The machine's **default space** lives in `machine.toml` and is set through `/api/v1/space/default`, outside the registry, because it is machine configuration, not an operation on a space. The service keeps the UI's machine-local state (3.14) in its state folder. |
| A4 | Instances with a label naming the account, a neutral monogram (`glyph`, for example "Cc"), a ring slot, a permission mode (`inherit`, `full-access`, `auto-edit`, `read-only`) and capabilities. Space references hold the default instance per space and area and the pinned instances in order. `launch.open` persists the intent and returns a receipt. Receipt and run states with A4's texts are in 3.9. v1 runs use the CLI adapters (`claude-print`, `codex-exec`). T3 is an Open route in v1, not a run adapter. Routines ("Refresh from sources", "Wrap-up") start with `routine.run`. Place resolution returns a folder with a `kind` (`place` or `work_folder`), or a reason. Resolution takes the nearest live place on this machine of the task, its project, then its area (A1). A task with none of these resolves to the space's **Tasks work folder** on this machine: machine-local, under the state folder, created on first use, allowed for runs by default and never a project folder. |
| A6 | The threat model, including v1's single-user-machine assumption for the browser origin and the M10 gate (3.26). The link rules and the "use at your own risk" text and its places. 3.26 implements A6's UI part. |
| A7 | Which milestone ships which part of this appendix, and the prototype importer, whose preview reuses the proposal component (3.10). |

Agents can never launch, run, change routines or change policy (R7). Every Open, Run, Refresh and Wrap-up here is a user action in the UI or CLI.

### 3.3 App shell and navigation

Built, in `packages/web/src/app/`: the frame (`Shell.tsx`), the sidebar, the space switcher, the top bar's add field, the routes (`router.tsx`, with `src/route.ts` reading what arrives from outside), the landing (`Landing.tsx`), and view membership and counts (`views.ts`). Tests: `A5.3.3.web.route`, `A5.3.3.web.landing`, `A5.3.3.web.views`, `A7.3.12.m5-01.e2e.space-per-tab`, `A7.3.12.m5-01.e2e.task-links` and `A7.3.12.m5-01.e2e.add-once`. The host view of a task link is built (`app/host.ts`, `app/pages.tsx`; tests `A5.3.3.web.task-host`, `A7.3.12.m5-06.e2e.task-links`). Not built yet: Refresh, New space and Open folder in the switcher, the Agents live dot, the replica machine name and `/setup/:step`. Until the views of 3.5 exist, each of them shows the grouped list filtered by its membership, and Completed holds only the task a link named.

**Frame.** A sidebar and a left-aligned main column, separated by space, not a border. The browser tab's title is "<view> · <space>".

**Sidebar**, top to bottom, with no headings: the space switcher, the views, the areas after a gap, and Settings at the foot.

- **The space switcher.** **Switching changes only this browser tab.** The tab's space lives in its route (`/s/:space/…`), so switching navigates, takes a fresh snapshot of the new space and moves the tab's feed to it. Other tabs keep their space, view, feed and drafts. Drafts are kept per space and task, so they survive a switch and a switch back. Sessions and other bindings stay pinned to their own space. "Make default" and `tasks space use <space>` are the only ways to set the machine's default space, and the default decides only what a new tab and an unbound CLI call use. The popover also offers "New space" and "Open folder". When a later phase shows a replica of another machine's space (A6), the switcher is the one place that shows that machine's name and, while it is unreachable, one "as of 10:42" time.
- **Views:** Today, Inbox (only when not empty), Open, Waiting, Review, Backlog (only when not empty), Completed, Agents. An empty Inbox or Backlog keeps its slot, so its appearance never moves another item. Counts (U2) are part of the link's accessible name ("Waiting, 2 tasks"). Agents shows a small live dot while a session or run is active, not a number.
- **Areas:** a coloured dot and the name, no counts. An open area lists its projects beneath it.

**Top bar** (64 px): the search-or-add field (3.13), a New task button, and at the inline end **Refresh**. Refresh starts the space's refresh routine ("Refresh from sources", D8). While it runs, the icon turns slowly and its tooltip reads "Refreshing · started 08:12". When it finishes, a toast says "Refresh finished · Show changes". The bar has no date, avatar or settings button. The add field sends an add once while its text waits for the feed's confirmation (3.15 item 4).

**Status bar.** A one-line bar under the top bar, only for service problems (3.16).

**Routes.** Every screen has a URL, so reload, Back and Forward work and agents can print links. Every parameter comes from the URL, so each is checked by its shape before use, and a path of another shape lands on `/`. `/` opens the machine's default space when the service serves it, else the one served space; otherwise the person picks, and a default that is set but not served is never replaced by another space. `tasks open` puts the route the tab should open in the URL fragment next to the one-time code; the page removes the fragment before any request. `tasks://` links (A6) map to the task route and only navigate. Still to add: `/setup/:step` (3.17). **The service answers with the page only for paths of `APP_ROUTE`'s shape** (`packages/service/src/http/checks.ts`: `/`, `/index.html`, and `/s/<space>` plus at most four plain segments). A route outside that shape, such as `/setup/:step`, widens that rule in the same change, or reloading it fails.

**Task links.** Related learnings, completed search results, digest lines, toasts and agents' printed links all use `/s/:space/task/:id`, for a task in any lifecycle. The route finds the task in the live rows, or else reads it with `task.get`, and picks a host view from its state:

| Task state | Host view |
|---|---|
| Active, in Inbox | Inbox |
| Active, with an area | The area view, in its project group |
| Active, no area, not in Inbox | Its status view (Open for a status without a view) |
| Completed, or archived (dropped) | Completed, in "Checked off" or its month group |
| Deleted and still restorable | Settings › Data › Trash, expanded read-only with Restore |
| Purged or unknown | The space's landing view and the toast "This task no longer exists" |

**The expanded task is in the URL.** The task route replaces itself with its host view's route and `?task=<ref>` (`/s/:space/area/:area?task=M-14`), and every view, area and project route holds its expanded task the same way: expanding a row writes `?task=` by replacing the history entry, so expanding several rows in turn adds no history. Collapsing pushes the view's own route without it, so Back returns to the task, expanded. Reload, Back and Forward restore the same view, injected row and expansion. One URL form for every expansion keeps the view's list mounted (a route of its own would remount the list and lose its place), and the link still names the task. A task the URL names that does not exist leaves the URL without a history step, with the toast.

The host view runs its normal query unchanged. When its rows or loaded pages do not contain the task (a completed task, an area view under a day filter), the list reads it with `task.get` and **injects the target row** at the top of its group, expanded. The injected row is not part of the view's query, counts or paging, and it leaves when it is collapsed, when another task expands, or when the route changes; the live row replaces it as soon as the store holds the task. Its title and summary come from the digest, which bounds them (A3 3.9.6): a text the digest cut ends in an ellipsis. The person's choice wins over the URL's lookup: a `task.get` of the URL's task that answers after the person expanded or collapsed a row, or after the URL moved on, is dropped, and until the router writes the person's URL, a frame that renders with the old one does not apply it again. If the task's state changes while it is open (an agent completes it, or moves it out of the view), it stays expanded where it is with its last data, and the host view is re-resolved on the next navigation.

A restorable deleted task cannot be linked yet: `task.get` refuses a tombstoned task until M3.04 adds tombstones and the UI read of them, and Trash is M5.11's. The route already resolves its host (`hostOf`, which lands on the landing view with "This task is in the Trash" until Trash exists); meanwhile `task.get` answers `not_found`, so such a link gets "This task no longer exists".

**Widths.** Desktop (≥ 1,360 px) and laptop (1,024–1,359 px, which includes a laptop at 125 % scaling) use the full frame. Narrow (600–1,023 px) turns the sidebar into a drawer and the expanded task into one column. Phone layouts are not a v1 target, but nothing scrolls horizontally down to 320 CSS px (WCAG 1.4.10).

### 3.4 Today

Built, in `packages/web/src/`: the selection, the strip's marks and the held expanded task as pure functions in `app/views.ts` (`todayOf`, `holdExpanded`), the page in `views/Today.tsx`, which hands its sections to the one list (`TaskList`'s `groups`), and the interim Changes source in `app/changes.ts`. Tests: `A5.3.4.web.today`, `A5.3.4.web.today-disjoint` (the property: no task in two sections), `A5.3.4.web.today-page` and `A7.3.12.m5-04.e2e.today`. Still to build: the digest's lines, cursor and Clear (3.14, M5.09), the strip's feature flag (M5.11), and `today.next_limit` read from the space's preferences once the snapshot carries them (until then Next takes 3).

Today has no heading. From top to bottom:

**1. Week strip.** Seven cells, today first. Each cell shows the weekday and day ("Fri 13"). Today's cell shows "Thu 12 Nov", in text colour, with a 2 px accent underline. This is the only date in the app's chrome. Under each day are up to four 6 px marks, one per task due or planned that day, coloured by area. A hollow indigo ring marks a waiting task's follow-up day (its `planned_for`). More than four marks show four and a small plus. The strip shows no numbers. Each row keeps its own due date, because a mark shows load per day, not the task's date. Hovering or focusing a cell lists the titles in its tooltip. Clicking a cell filters Focus and This week to that day. Clicking it again, or `Esc`, clears the filter. The strip is a feature flag.

- **What a mark stands for.** The strip marks the tasks Focus and This week select, so a day's marks are exactly the tasks its filter shows. A task marks its due day and, on another day, its planned day: a dot, or the ring when the task is waiting. A backlog task without a star and a task off Today mark nothing.
- **The day filter** narrows what Focus and This week show to the tasks due or planned that day, and leaves Next and Changes as they are. A task the filter hides keeps its section, so it never drops into Next. Rows keep their own due date under the filter (no `due` is implied). The chosen day is in the URL (`?day=YYYY-MM-DD`, a step Back undoes), and a day outside the strip's seven is ignored.
- **Keyboard and names.** The cells are one tab stop (the chosen day, else today), and the arrows, `Home` and `End` move along them. `Esc` clears the filter once nothing inside Today (an expanded task, an editor) has taken it. Each cell is a toggle (`aria-pressed`) named by its full date ("Thursday 12 November"), today's with `aria-current="date"`, and described by its tasks' titles, which are also its tooltip.

**2. Sections.** Each section is a small heading (12.5 px, muted) and a list of rows. A section with no rows is not rendered. A task appears in the first section that selects it and in no other.

| Section | Selects | Order |
|---|---|---|
| **Focus** | Active tasks that are starred (`focus_on` today or earlier). Active tasks, except backlog, that are due today or late, or planned for today or earlier (`planned_for`) | Late first (oldest due first), then due today, then priority, then due date, then age |
| **This week** | Not in Focus. Active tasks, except backlog, due or planned in the next six days. A waiting task's planned day is its follow-up day | By date, then priority |
| **Next** | Not above. Status open, not in Inbox. Up to `today.next_limit` (default 3) | Priority, then due date (undated last), then `position` (the space's order, which agents may set), then age (oldest first) |
| **Changes** | Agent changes since the digest cursor, on tasks not shown above (3.14) | Newest first, at most 5 lines |

- **Late** is a due day before today, or a due time today that has passed (the row says "late" for both). Focus orders its late tasks by their due, oldest first.
- **This week's date** is the day that selects the task: the earlier of its due and planned days inside the six days.
- **Next's "not above"** covers every task Focus and This week select, shown or hidden by the day filter. Its order ends with the task's ID, so equal tasks never swap between renders.
- **Changes until the digest exists (M5.09).** The page has no digest cursor yet, so Changes lists the tasks an agent or a routine changed while this tab followed the space (the feed names each commit's actor), newest first, at most five, dropping off after seven days. The person's own changes, the system's, an import's and launches do not count. A reload starts it empty, as a cleared digest would, and the rows are ordinary rows until 3.14's lines replace them.
- **What day it is.** Today is the browser's calendar date in its time zone. The page moves to the next day at midnight, each minute while a shown task has a due time, and whenever the tab is shown again or the window gets focus, so a machine that slept past midnight or changed time zone shows the right day at once.
- **The expanded task stays where it is** (3.15): while it is expanded, an update that would move it inside its section, to another section, or off Today, leaves it at its place in the section it was in, with its latest data, and its reference stays in `?task=`. It goes where Today puts it once it is collapsed and focus leaves it. An expanded task Today does not select and has not shown (a reload or a link that names it) sits at the top of Focus. Holding it keeps the sections disjoint.

**The star carries over.** Starring sets `focus_on` to today. The task then stays in Focus every day until it is unstarred or completed. Unstarring clears `focus_on`. If starring for a future day ships later, the same rule shows the task from that day.

Today is computed from task state in the client. Opening it never calls a model. Unstarred waiting, review and backlog tasks without a date in the window do not appear on Today. The sidebar counts show that they exist. Today has no Review section (open item 2).

**Rows on Today** mix areas, so the summary line starts with the area dot and the project name ("● Lumen Health · Check the CSV columns…"). Titles stay aligned at the left edge.

**Fixture example.** Mira has starred "Fix appointment time zones" and "Investigate checkout crash on Android 15".

- Strip: Fri 13 one clay mark. Sat 14 clay and fern. Mon 16 an indigo ring (the photos task is planned for Monday, when Tom sends them). Tue 17 clay and fern.
- Focus: Fix appointment time zones, Investigate checkout crash on Android 15.
- This week: Review Jonas's pull request (Sat 14), Sign the lease (Sat 14), New product photos (waiting on Tom Haas, Mon 16), Release 2.4 to the app stores (Tue 17), Dentist check-up (Tue 17).
- Next: Book the moving van (P2, 21 Nov), File the Q4 VAT return (P2, 30 Nov), Release 1.9 with structured fields (P2, undated).
- Changes: "Claude Code added _Agent finished the docs migration, check it_ for review · 09:40".

**Empty Today.** The strip and one muted line, "Nothing planned."

### 3.5 Other views

All lists use one list component and one row function (3.6). Group headings never carry counts. The status views follow the space's `tasks.statuses` preference (default open, waiting, review, backlog), so a renamed or added status gets its own view without code.

| View | Content | Grouping and row context |
|---|---|---|
| **Inbox** | Active tasks with the `inbox` flag: quick captures without an area, and agent-created tasks when the space sends them to Inbox (D13, A3 `agent_tasks_to_inbox`). Inbox tasks appear in no status view until triaged | Flat, newest first. The age tooltip names the creator ("Created by Codex · 08:15"). A visible "Move to Open" button clears the flag. Keys: `a` area, `x` done, `Shift+X` drop |
| **Open** | Status open | Area heading (14 px, weight 600, area dot), then project label (13 px, muted, hairline to the end). No status chip |
| **Waiting** | Status waiting | Grouped by person (`waiting_on`), which is the group label, so no chip. Age shows "waiting since". The due column shows the follow-up day (`planned_for`) in indigo (open item 13). Mixed areas, so the project prefix shows |
| **Review** | Pending proposals first (3.10), then status review | Proposals grouped by session or run. Review rows are flat, newest first, with a visible "Back to open" button. The checkbox means done, and on a task with a pending completion proposal it accepts that proposal (A3) |
| **Backlog** | Status backlog | Like Open |
| **Completed** | Lifecycle `completed` or `archived` (dropped) | A first group, **"Checked off"** (A1's checked-off list: `wrap_state = pending`), with one Wrap-up button on its heading. Then one group per completion month. The row shows a check or drop glyph, the title, and the **outcome** as its summary line. The due column shows the completion date |
| **Agents** | Sessions, runs and routines | "Running", then "Routines" (each with its Run button and last run time), then "Recent" by day. Each entry expands to the changes it made, with Revert per line and Revert all |
| **Area** | Every unfinished status in one area | Grouped by project. Status chips on non-open rows. Backlog rows sort last in their group |
| **Search** | Results of the top field | Groups: Tasks, Completed, Learnings, Go to |

**Expanded completed task.** The left column shows the outcome, then the learnings under "Learnings", the one label kept in the app, because a bare list would be ambiguous. Context, sources and the full thread follow, unchanged. Wrap-up never trims anything (D12). The facts are read-only, with a Reopen button. The composer stays. A reopened task keeps its old outcome and learnings as the previous result (A1), shown in the thread as one entry, "Completed 6 Nov", with the outcome text.

**Wrap-up** starts A4's "Wrap-up" routine for the tasks in that group. Its results arrive as normal operations attributed to "routine: Wrap-up", which the user can revert. A stopped routine keeps the tasks it finished.

### 3.6 The task row

Built, in `packages/web/src/row/`: `model.ts` (`renderRow`, `contextFor`), `Row.tsx`, `launch.ts` (the tile's state and click), `dates.ts` and `Row.module.css` (column widths and the narrow-width drops). Tests: `A5.3.6.web.render-row` (one case per view), `A5.3.6.web.row-columns`, `A5.3.6.web.tile` and the screenshots `A7.3.12.m5-03.e2e.rows`.

**Anatomy.** Marker, check, title and summary, then fixed columns: due, age, priority, sources, folder, star and launch. An empty column keeps its width, so columns line up on every row. Due text never relies on colour alone ("2d late", "Today", "Sat 14"). At narrow widths sources, folder, age and priority drop in that order. Due, star and launch never drop.

**The row function.** Every row in every view comes from one pure function, `renderRow(row, ctx)`. `contextFor(view, grouping, clock)` states what the view or the row's group already says (area, project, status, waiting person, due through a day filter). Implied facts are not rendered, and the accessible description omits them too. The model holds message IDs with their values, never text, so the function stays pure and the words stay in the catalogue (3.23).

**The launch tile** shows the effective instance's monogram ("Cc", "Cx", "T3") in a box outlined in the instance's ring colour (3.19). Two enabled instances never share monogram and ring, so "Codex · work" and "Codex · personal" differ at a glance, and the tooltip's label names the account. When only one instance is enabled, the tile shows a plain open glyph instead. **Only Ready starts a launch** (`tileClick`). A click on any other state must not open, because a Connected tile clicked after A4's 5 s window would start a second session. A link launch stays "not confirmed" until A4 confirms it, and a terminal launch shows Opening until its receipt settles.

Until A4's per-area default reaches the page, the effective instance is the first instance the page gets (3.28), and with none the tile is Copy only. Its state comes from the task's receipts, which the tab reads for the tasks it expanded or launched and for a task a launch event names (open item 11). After a reload a tile is Ready until its receipts are read.

**Sources and folder.** The compact row carries the task's first three sources with their own text, key and URL, how many more it has, and its own place's state on this machine (A1 3.7), so the sources column shows up to three kind icons and "+2", each a link only through an allowed scheme, and the folder slot shows a folder here, one not found here, or one on another machine. A task without a place keeps the folder slot empty until the Tasks work folder exists (M6). The state is resolved when the snapshot or batch is read: a folder that appears or disappears later shows at the next change to the task or the next snapshot.

**What the row still lacks from the service.** The snapshot and the compact row must also carry each task's launch block (Unavailable, Elsewhere, or the area set to "no agents"), its latest launch per instance (so a tile shows Connected after a reload), the changed and needs-input markers (3.14), and when its current wait began (for the Waiting view's age). Until each arrives, its column stays empty at its width, and a Waiting row shows the task's age with the tooltip "Created".

**Check-off and the star.** The checkbox checks an open task off with the hold, toast and undo of 3.12, and during this tab's own hold a second click undoes it. A finished task's box shows checked and is disabled: reopening is the facts' Reopen (3.5). The star is a person's edit like every other (3.11): it shows at once, carries a base and joins undo and conflicts.

**Row behaviour.** A click on the title or summary toggles expansion. Icons and the checkbox are separate targets and never expand. One task is expanded at a time. Hover gives a subtle background and nothing else. The row owns its expansion and its region, which holds `src/task/Expanded.tsx`; 3.7 replaces that component and keeps its props.

**Agents and titles.** Status and people are fields, so titles do not repeat them ("Waiting on Tom: new product photos" becomes "New product photos" with the waiting chip). A3's server instructions tell agents this.

### 3.7 The expanded task

Built, in `packages/web/src/task/`: `Expanded.tsx` (the body and the facts), `Thread.tsx`, `detail.ts` and `useDetail.ts` (the detail read and its refetch), `markdown.tsx` (3.26), and the header in `row/Row.tsx`. Tests: `A5.3.7.web.detail`, `A5.3.15.web.expanded-state`, `A5.3.26.web.markdown`, `A7.3.12.m5-06.e2e.expanded`, `A7.3.12.m5-06.e2e.keyboard`, `A7.3.12.m5-06.e2e.screens`. The facts are edited in place (`Facts.tsx`, `DuePicker.tsx`, `AreaPicker.tsx`; 3.11), and the composer's field holds its draft (`Composer.tsx`, `composer.ts`; 3.8). Still to build: the proposal card (M5.09), the place's Change and Choose folder (it needs the service's folder type-ahead), the composer's strip (M5.07; until then a button per instance and Copy sit under the field), Open folder (with `place.reveal`), related learnings (A3's learning search), runs (M6) and grouped field changes with Revert (M5.09).

**The detail.** The live row holds the header's and the facts' data. The rest comes from `task.get` in two reads that start together: the digest for the task's own facts in any lifecycle (its place on this machine, when it was created), and the sections (instructions, context, notes, log, sources, outcome) read page after page, at most 20 pages, joining a text a page boundary split. The detail is read again whenever a frame of the feed touches the task (3.15 item 8), and after a fresh snapshot, which names only the working set's tasks and so not a completed one. A read that fails keeps what is shown and says it may be out of date.

The row becomes a card on `--k-raised` (radius 12) in place. The mockup shows the layout.

**Header.** Checkbox, title, summary under it (wrapped, not truncated), and at the inline end the star and a collapse button, which takes the launch tile's column. The due, age, priority, source and folder slots fade out, and the status chip and the area and project prefix go, because the body now owns those facts. The title edits in place with `F2` or a double-click, for typo fixes: Enter or leaving the field saves it as a person's edit (3.11), with the cursor the editor opened at as its base, so a title someone changed while the person typed is a conflict and is never overwritten: the field says "Changed by Codex just now" while the person types, and after the save the header keeps their title under the current one with Apply mine. Leaving the window is not leaving the field. Escape keeps the old title, and focus returns to the title. The collapse button puts focus on the title before the card closes, as Escape does. Only an open task's title edits, the one kind the service changes.

**Body.** Two columns: content `1fr` and facts 252 px, with a 40 px gap. The content aligns with the title.

**Left column, top to bottom, with no section labels:**

1. **Proposal card**, when one is pending (3.10). Full width.
   - **Outcome**, once the task is completed: the outcome as Markdown with the outcome icon. The task's own learnings follow among the links, with the learning icon, before any related ones.
2. **Context**: the agent-maintained understanding, as Markdown (3.26) in `--k-text-2`. Over 10 lines it clamps with a "More" button.
3. **Links**: one line each, icon first.
   - Sources show their own text: "Wrong appointment times since Sunday · Ana Reyes" (mail), "LUM-212 Appointments off by one hour" (ticket, key in mono), "#lumen-dev · Jonas Berg" (chat). No "Email" label and no domain. The domain and URL are in the tooltip. A source whose own text is the task's title or summary (a task named after its email), read without case, spacing or a closing full stop, shows its key instead, or its kind's name ("Document") when it has none, so the card shows the string once.
   - The place: `~/work/lumen/portal` in mono, with Open folder, Copy path and Change. The machine is in the tooltip. A missing place shows the path muted, "Not found on this machine", and "Choose folder". A task without a place shows "Tasks work folder" in muted text, with Open folder and Copy path once it exists, and "Choose folder" to give the task a real place. The tooltip gives the path and says that Open and Run use it.
   - Related learnings (R12), the best three from A3's learning search, often fewer: the learning text and a muted link to its completed task ("Always store UTC plus the clinic's zone ID, never offsets. · Fix DST bug in reports, Apr").
4. A hairline.
5. **Thread**: notes, log entries, requests, sessions, runs and grouped agent field changes, oldest first, ending at the composer. The last six entries show. An "Earlier" button above them reveals the rest. An entry that holds focus stays shown while entries arrive: the window grows to keep it until focus leaves it (3.15). Each entry: actor mark (the user's initial or the instance monogram), actor, mode ("run", "session"), relative time, then the text. Entry actions appear on hover and focus: Edit and Delete on the user's own notes, Copy on log entries, Revert on agent field changes, and Resume, Stop or Log on sessions and runs (3.9). Consecutive field changes by one actor within two minutes collapse into one entry ("Codex changed due, priority and effort").

**Right column: facts.** A two-column list with short muted labels. A finished task's facts are read-only text; an open task's are the controls below, and a fact without a value is an empty control a person can fill ("No date", "No area", no option chosen).

| Fact | Control | Notes |
|---|---|---|
| Status | Segmented: the space's statuses (default Open, Waiting, Review, Backlog). While the task is in Inbox, a "Move to Open" button sits beside it | Choosing Waiting adds the next row |
| Waiting on | Person type-ahead, plus an optional expected date | Only while waiting |
| Priority | Segmented: P1, P2, P3. Clicking the active one sets P4 (no priority) |  |
| Effort | Segmented: the space's effort scale (`tasks.effort_scale`, default S, M, L). Clicking the active one clears it |  |
| Due | A pill button ("Fri 13 Nov") that opens the date popover (3.11) | Relative words are in the tooltip, so the date is not shown twice |
| Area | A pill button with the area dot ("Client work › Lumen Health") that opens a type-ahead |  |
| Created | "9 Nov · 3d" | Read-only. The only place age appears while expanded. A task created today shows "today" alone, so today's date stays the strip's (U1) |

Editable values sit in outlined controls. Agent-only text has no outline. That outline is the only hint that a value can be changed by hand.

**Composer**, full width at the bottom (3.8). When the card is taller than the viewport, the composer sticks to the viewport bottom while the card is on screen.

**Reflow below 1,024 px.** One column in DOM order: header, proposal, facts (as a wrapping line of pills), context, links, thread, composer. CSS `order` is never used, so reading order equals visual order. So the facts come before the content in the document, and at full width the grid places them in their column by area.

**Collapse.** `Esc`, the collapse button, or a click on the title. Focus returns to the row.

### 3.8 The composer and its actions

**The field.** A text area that starts at one line and grows to six. Placeholder: "Add a note or ask an agent". Drafts persist per space and task in `localStorage` as a per-viewer convenience. Every storage access is wrapped in try/catch, and losing a draft is harmless. A draft read back is untrusted text (3.24). Like the token, drafts sit in the origin's storage, which v1 trusts only on a single-user machine (3.26). Built with its draft and click-to-ask (`src/task/Composer.tsx`, `composer.ts`); until the strip below exists (M5.07), Enter makes a new line and nothing is sent. M5.07 connects the strip's actions to the field's text, clears it after Note and a dispatched launch, and keeps listening to `onAsk`.

**The strip** under the field: a `toolbar` named "Act on this task", with arrow-key navigation.

```
[Note] │ [Cc Claude Code] [Cx Codex] [T3 T3 Code]                    [▷ Run] [⧉ Copy]
         default instance first, filled accent
```

| Action | Key | What happens |
|---|---|---|
| **Note** | `Enter` | Saves the text as a note (`note.add`). No agent is involved. `Shift+Enter` inserts a newline |
| **Open** in an instance | `Ctrl+Enter` for the default. Click for the others | Calls `launch.open` with the text. The app opens visibly in the task's folder with the brief (R14). The composer text replaces the brief's last line ("wait for my instructions"), as A4 specifies, and never reaches the space. Over A4's budget it is saved as a note addressed to agents and the brief points at it. `launch.open` answers where it went (`none`, `inline` or `note`). The default instance is filled with the accent, the others are outlined |
| **Run** | `Ctrl+Shift+Enter` in the composer, `Shift+R` on a row | Starts a background run in the task's place (or the Tasks work folder) with the text as the request. Progress and the reply land in the thread. A run never completes the task (R9). v1 runs only through the CLI adapters (A4), so Run uses the effective instance when it is a Claude Code or Codex instance, and otherwise the first pinned instance that can run. The button's name says which ("Run in the background with Codex · work"). With none, Run is disabled with "No instance here can run in the background" |
| **Copy** | Click. `Shift`+click copies the context pack | Copies the pointer brief with the text (`launch.open` without an instance, 3.28), or the context pack for apps without the Tasks tools (A4). Toast: "Copied" or "Context pack copied" |

**Asking an agent** is Open with text (interactive, in the agent app) or Run with text (in the background, reply in the thread). A4 has no Ask mode, so the strip has no third verb (open item 4). Clicking an agent-only field (3.11) starts such a request in the field.

Rules:

- **Instances shown.** The space's pinned instances (A4 space references), default first, in their saved order. If they do not fit on one line, the strip wraps. There is never an overflow menu. A pinned instance that does not exist on this machine shows "Not set up on this machine" and stays disabled.
- **Empty field.** Note is disabled. Open sends the brief alone. Run focuses the field with the placeholder "What should the agent do?" and waits.
- **Text after an action.** Note, and a launch or run that reaches Dispatched or `queued`, clear the field. If a launch fails or becomes Unknown, its text goes back into the field.
- **Questions before dispatch.** While a launch is Prepared, A4 may need an answer: the account check ("This task is in Work. Codex · personal is for personal work. Open anyway?"), "Register in T3?", a pre-trust step, or the permission mode for an `inherit` instance's first Run. Each appears as one inline line in place of the strip's buttons, with the exact subject and two buttons. There is no dialog. T3's question reads "Register <name> as a T3 project?" with Register and Not now. Not now is kept per place for 30 days, and meanwhile T3 is Unavailable there with "T3 opens only registered folders". Declining closes the Prepared intent. Until the service offers a cancel, its sweep expires it.
- **First Run per instance and machine.** The same inline line: "Codex · work runs with full access in ~/work/lumen/portal · Run · Cancel". After one confirmation it never shows again, unless the instance's permission mode changes.
- **No place.** For a task without a place, Open and Run work in the space's **Tasks work folder** (3.2, A4), never a project folder (R11). Each route asks its usual questions there, and the inline questions and the first-Run confirmation name it ("Codex · work runs with full access in Tasks work folder · Run · Cancel"), so the user sees where the agent works. A task _with_ a place always uses exactly that place, and a missing place stays Unavailable rather than falling back to the work folder. Copy stays available.
- **Disabled buttons** stay visible and focusable at reduced opacity, with the reason in the tooltip: "Folder not found on this machine", "Not set up on this machine", "No graphical session", "Opens on mira-desktop".
- **Accessible names** spell everything out: "Open in Codex · work (full access)", "Run in the background with Codex · work (full access)". The permission mode is part of the name, not only the tooltip.

### 3.9 Launch receipts and run status

The UI draws A4's states with A4's texts (A4 3.9.4). It never invents a state and never retries a launch by itself (R8).

**Launch receipts** appear as an entry in the task's thread and, for a few seconds, as a line beside the button that started them. The row's launch tile mirrors them (3.6). A receipt reaches the page as a `launch` entity in the feed (3.15, open item 11).

Every refetch the feed triggers (a task's receipts, the expanded task's thread) applies only while its request is the newest for that key (`packages/web/src/latest.ts`, test `A5.3.9.web.refetch`). Otherwise a late older answer could take Confirmed or a new entry away.

| Receipt state | Thread entry | Actions |
|---|---|---|
| Prepared | Nothing yet. A4's questions appear inline in the strip (3.8) | — |
| Dispatching | "Opening in Codex · work…" with a small spinner | — |
| Dispatched, terminal route | "Opening…" (it settles within 120 s) | — |
| Dispatched, link route | "Opened · not confirmed", with a hollow ring. It stays like this, because the session may well exist | Copy brief |
| Confirmed | "Open in Claude Code" with a live dot while the session is bound, then the session's end state ("Claude Code · session · 10:12–11:03") | Focus (where possible), Resume when A4 allows it. Resume appears only with a known native session ID, never from folder and time (A4) |
| Failed | One persimmon line with the reason ("Ghostty did not start"). A sticky error toast with Details | The next route when A4 offers one, Copy |
| Unknown | "Tasks lost track of this launch. It may have opened." in ochre | Check, Open again (a new intent), Copy. Nothing happens without a click |

A Copy is a launch too (route and instance `clipboard`). It is Dispatched at once and never confirmed, and its entry reads "Brief copied · not confirmed". A copy the browser refuses is not reported back.

"Connected" is the live label of a Confirmed, bound session. It appears only when A3 and A4 confirm the binding. The UI never infers it from folder or time.

**Runs** appear as a thread entry and in the Agents view.

| Run state | Display | Actions |
|---|---|---|
| `queued` | "Codex · run · queued" | Cancel |
| `starting`, `running` | Live dot, "running · 3 min", and the latest progress line when A4 reports one | Stop, Log |
| `waiting_for_input` | Wisteria ring, "needs your input", and the question when reported. The row gets the needs-input marker | Continue interactively (when A4 supports it), Log |
| `reconciling` | "checking…" after a service restart | — |
| `cancelling` | "stopping…" | — |
| `succeeded` | "finished after 6 min", then the run's result text. "Finished" describes the process, not the work | Log, Run again, Continue interactively |
| `failed`, `timed_out` | Persimmon, "failed after 2 min" or "timed out after 30 min", and the reason | Log, Run again, Continue interactively |
| `cancelled` | Muted, "stopped" | Log |
| `unknown` | Ochre, "state unknown" | Log, Run again, Continue interactively (when A4 supports it) |

Stop asks once inline ("Stop run? · Stop"). Continue interactively on a running run first asks "Stop the run and continue in a terminal?" (A4). A run whose MCP server did not connect says "without the Tasks tools" in its entry. Routines show the same states in the Agents view and on the Refresh button.

### 3.10 Proposals and review

A3 decides per action what an agent change does. At **Full**, changes apply. At **Review**, most changes apply with the changed dot, and completions and drops become proposals. At **Suggest**, most changes become proposals. Per-area and per-action overrides can change this.

**The proposal card** sits at the top of the expanded task's body, full width, on `--k-surface` (open item 14) with a wisteria line at the inline start.

- Header: the instance monogram, "Codex proposes", the agent's reason in plain text, and the time. Accept (`y`, accent button) and Reject (text button) at the inline end. Both are undoable.
- Field changes: one line per field, with the label, the old value struck through with a minus glyph, and the new value with a plus glyph. The diff never relies on colour alone.
- Text changes: an inline word diff (removed words struck through, added words underlined).
- With more than one field, each line has its own Accept and Reject.
- **Stale fields.** A field whose version moved since the proposal (A3 accepts a field only at its base version) shows "Changed since by you at 10:50" with its current value, and two buttons: "Apply anyway" (as the user's own change) and "Skip".
- A completion proposal shows the outcome and learnings that will be written. Checking the task off accepts it (A3).
- Reject takes an optional one-line reason, which the proposing agent can read.

**Where proposals appear.** In the expanded task, at the top of the Review view (grouped by session or run, with Accept all and Reject all per group), and as the needs-input ring on the row. The Review count in the sidebar includes pending proposals (open item 12).

**The same component** shows three other previews:

- **Import conflicts** (A1, D10): a field with `base`, `current` and `edited` values, and "Keep current" or "Take edited".
- **Revert plans**: Revert all for a session or run first fetches A1's `dry_run` plan, shows the fields it restores and any conflicts, then applies on confirmation. One line under the plan reads "Reverting cannot recall what the agent did outside Tasks, such as sent email or pushed commits".
- **Setup changes** (3.17), with a file path in place of the field label.

### 3.11 Field editing

Built, in `packages/web/src/edit/` (`edits.ts`, `change.ts`, `due.ts`, `Unsaved.tsx`) and the facts in `src/task/` (3.7). Tests: `A5.3.11.web.edits`, `A5.3.11.web.due`, `A7.3.12.m5-08.e2e.flow`, `A7.3.12.m5-08.e2e.conflict`, `A7.3.12.m5-08.e2e.ask`, `A7.3.12.m5-08.e2e.screens`. By hand today: done, star, priority, effort, due, status, waiting on, Move to Open, area and project, and the title. Not yet: Drop (the service refuses `dropped` until M3.04), waiting on's expected date (`task.update` has no `planned_for`), the place (it needs the service's folder type-ahead), moving a task out of every area (`task.update` moves into an area or project only), and the row keys, which come with `ui.keys.single` (M5.11). The statuses and the effort scale are the defaults until the snapshot carries `tasks.statuses` and `tasks.effort_scale`; a task's own value outside them is shown as one more option.
| Field | By hand | Control | Row key |
|---|---|---|---|
| Done | Yes | Checkbox | `x` |
| Drop (won't do) | Yes | "Drop" text button beside the status control, with an optional one-line reason (A1 archives the task) | `Shift+X` |
| Star | Yes | Star | `s` |
| Priority | Yes | Segmented control | `1`, `2`, `3`. `0` sets P4 (none) |
| Effort | Yes | Segmented control | `e` cycles the effort scale, then none |
| Due | Yes | Date popover | `d` |
| Status | Yes | Segmented control | `w` waiting, `b` backlog, `o` back to open |
| Waiting on, expected date | Yes | Type-ahead, date | after `w` |
| Area and project | Yes | Type-ahead over the area tree | `a` |
| Place | Yes | Type-ahead over roots and their subfolders (served by the service). Clearing it removes the task's own place: the task then uses its project's or area's place on this machine, or the Tasks work folder when neither has one | — |
| Title | Yes, for typos | Inline edit | `F2` while expanded |
| Summary, context, sources, outcome, learnings | No | Click-to-ask | — |
| Notes | Own notes | Composer, Edit on the entry | `m` focuses the composer |

**The date popover.** A text field with a live preview ("Friday 20 November"), five quick picks (Today, Tomorrow, Next Monday, In a week, None) and a month grid with one tab stop (the arrows move a day or a week, Page Up and Page Down a month, Home and End to the week's ends). The text field reads an ISO date, `tod` and `today`, `tom` and `tomorrow`, weekday names (today on that day, as the service reads them), `+3d`, `+2w` and `-` to clear, and the page sends the calendar date it read, so the preview is exactly what is saved. chrono-node's phrases are not read: they would add a dependency for what the picks and the grid already cover. The grid is the page's own, not React Aria's Calendar, whose calendar systems would cost the bundle more than the grid. Unparseable text shows "Not a date" and Enter does nothing. A past date shows "in the past" in the preview. `Enter` applies and `Esc` cancels. Focus returns to the pill. A due time is shown, and an edit replaces it with a date: the service sets dates only.

**Click-to-ask.** Clicking an agent-only field (not a link or button inside it, and not the end of a text selection) focuses the composer with a stub such as "Change the summary: ", after whatever the person had written there, which stays. Its tooltip reads "Ask an agent to change this". It works for every task: a task without a place sends the request through Open or Run in the Tasks work folder (3.8). Built for the context, the outcome, a source's line, a learning and the expanded header's summary: `askFor` in `src/task/composer.ts` is the one entry point, and the composer's field listens for it. The keyboard's way to the same request is the composer itself.

**Writes.** Every hand edit takes one path, `Edits.edit` (`edit/edits.ts`), whatever control made it: the star, the title, a fact, Apply mine and Restore mine. It sends one `task.update` with a request ID and `base` through the live store, so the control shows the new value at once as an overlay (3.15 item 4), and a toast names it with Undo (3.12). No pending state is drawn: the overlay is the answer, and a refusal says so.
- **The base.** A control's edit takes the applied cursor when it is sent: what the rows on screen show. An editor that stays open while the person types or reads (the title, who it waits on, the date popover) takes it when it opens, so a change someone made meanwhile is a conflict, never overwritten. Edits of one task go out one after another: the next waits for the answer to the one before and takes that answer's `as_of` when the feed has not reached it, so two quick edits of one field never conflict with each other.
- **A refusal keeps the person's value.** On a conflict the control shows the current value, and the line under it says "Changed by Codex just now" with Apply mine (the person's value again, with a fresh base) and Keep theirs. A failed call shows "Not saved" with Try again and Discard. A toast says the same with the one action, for a control that is not on screen. The value waits per task and field in the tab's edits until the person chooses, through feed updates, fresh snapshots and a collapsed card. A reload loses it: it is the tab's, not the space's.
- **While an editor is open,** a change by someone else to its field shows under it ("Changed by Codex just now") and the typed text stays (3.15 item 9). Leaving the window, for another app or tab, does not end the editor.

**Settings and preferences** are operations too, so they are undoable.

### 3.12 Check-off, undo and the toast

Built, in `packages/web/src/edit/edits.ts` (check-off, the hold, undo and redo), `src/app/Toast.tsx` and the keys in `src/app/Shell.tsx`. Tests: `A5.3.12.web.undo`, `A7.3.12.m5-08.e2e.flow`, `A7.3.12.m5-08.e2e.conflict`. The rules below hold as built, with these decisions:
- **A toast's own commit** comes from the feed: the event that confirms the tab's write names its commit (`op_id`), and the store hands it to the write (`Sent.commit`). A write confirmed without such an event (a fresh snapshot covered it) has no commit the page knows, and its toast's Undo says so and leaves the change alone, never guessing: Ctrl+Z still undoes the newest change.
- **Restore mine** is offered when every field of the change an undo meets conflicts and each can be set by hand. It first undoes the change as far as it can (a partial undo), so the stack moves past it and the next Ctrl+Z reaches the change below rather than this conflict again, then applies the conflict's `restore` values as the person's edit with that undo's `as_of` as its base. When only some fields conflict, the action is Undo the rest. The page knows a change's fields for the tab's own commits; for another commit (Ctrl+Z after a reload) it offers Restore mine when every conflict can be restored. A value no hand edit can set (a due time, a lifecycle, an agent-only field, a child row) offers Undo the rest after an undo and nothing after a redo.
- **The hold** keeps the row's last data at its place in its view (`Leaving` in the tab's edits, merged into the list's rows), checked and struck through, for 4 s; a second click on its box undoes the check-off by its commit. After an undo the row shows unchecked at once and stays until the feed brings it back. A task another actor completes while the view shows it holds the same way, with the tooltip `"Completed by Codex · 10:42`" and no Undo. After the hold the row fades out in 180 ms (at once under reduced motion) and leaves; it does not animate its height, because the virtual list places rows by offset.
- **Toasts** are plain sentences 2.5 s, undo toasts 6 s and errors until dismissed (a dismiss button). Escape in the toast returns focus to where F6 took it from.
**Check-off** (D12) never waits for a model:

1. The checkbox fills and the title is struck through at once. The row **stays in place for 4 s**, so nothing moves under the pointer.
2. Focus moves to the next row immediately (or the previous row, then the view itself: a heading takes no focus).
3. The toast "Done · Undo" appears.
4. After the hold, the row collapses in 180 ms. Under reduced motion it disappears at once after the hold.

Other moves out of a view (drop, Waiting, Backlog, area set in Inbox) follow the same pattern with their own toast text. When an agent completes a task that is on screen, the row strikes through with the tooltip "Completed by Codex · 10:42", then leaves after the hold, unless it has focus.

**Toasts.** One at a time, at the bottom inline-start of the main column. A short past-tense sentence and at most one action: "Priority set to P1 · Undo", "Copied", "Claude Code did not open · Details". Undo toasts last 6 s, "Copied" 2 s, and errors stay until dismissed. Timers pause on hover and focus. A new toast replaces the old one, and the replaced change stays undoable with `Ctrl+Z`. `F6` moves focus to the toast's action.

**Undo and redo.** `Ctrl+Z` calls `history.undo` for the user's most recent undoable operation in this space (A1 3.10.1 keeps one stack per human principal, so every tab and the human CLI share it); a toast's Undo names its own commit, so it never takes back a change made since in another tab. `Ctrl+Shift+Z` and `Ctrl+Y` call `history.redo`. Undo works by field version, never by value (R2). When a field changed after the user's edit, undo stops and the toast says "Codex changed the due date at 10:42 · Restore mine". "Restore mine" applies the old value (the conflict's `restore`) as a new operation: an explicit choice, never a silent overwrite. When only some fields of the operation conflict, the toast's one action is "Undo the rest" instead (`partial`), which undoes the fields that pass and leaves the others as the other actor set them (A1 3.10.1). Undo shortcuts do nothing while focus is in a text field, where the browser's own text undo applies.

**Revert** of agent changes works the same way, per thread entry, per digest line, and per session or run in Agents (Revert all).

### 3.13 Quick capture and search

**One field for both.** `/` focuses it to search. `n` or the `+` button focuses it to add. In add mode the placeholder reads "New task" and `Enter` creates the task. `Ctrl+K` focuses it from anywhere, including inside text fields.

**Capture syntax**, parsed locally as the user types and shown as chips under the field: natural dates ("fri", "next week", "20 nov"), `p1`–`p3` (`p4` is accepted and is the default), `#area` or `#area/project` with type-ahead, `@person` (sets waiting on), and `*` (star). The rest is the title. `Shift+Enter` creates and keeps the field open for the next task. An ambiguous date shows both readings as chips, and the user picks one before Enter is accepted.

**Where a capture lands.** In the current context: an area view uses that area, Waiting uses waiting, a day filtered on Today uses that due date. A task without an area goes to **Inbox**.

**Search.** Typing in search mode filters after 120 ms of quiet. Results replace the view, with no title, because the query is the title. Groups (hidden when empty): Tasks, Completed, Learnings (the learning text and a link to its task), Go to (views, areas and settings sections). Matches are highlighted with `<mark>`. Filters follow A3's query language, for example `timezone area:client status:open due<7d p:1 src:mail`. Unknown filters get a dotted underline and a tooltip. The last row is always `Add "…"` with the parsed chips, so search falls through to capture. "Show more" pages with the snapshot cursor (R12). `Esc` clears the field and restores the previous view and focus.

**Search results are a frozen snapshot.** The result list and its cursor belong to one snapshot, so paging never skips or repeats a row and nothing re-sorts under the reader. Rows already shown take new field values from live events in place. When an event could change which tasks match or their order (a change to a task's searchable text or to a field the query filters or sorts on, task creation, lifecycle changes and deletion), one muted line appears above the results: "Results changed · Refresh". Refresh restarts the query from a new snapshot, loads as many rows as were shown and keeps focus on the same task when it still matches. If the service reports that the cursor expired, the client refreshes the same way without asking.

Global capture outside the browser (an OS hotkey or the PWA) comes later through `tasks capture` (A2).

### 3.14 Agent changes: the marker and the digest

**The changed marker.** A task shows the 6 px accent dot when an operation by any actor other than the user (agent session, run, routine, import, another machine) has a sequence number above the task's `seen` cursor. The prototype import is the exception: its tasks start as seen and get no dot (A7 3.15.3). The tooltip names the latest change: "Codex moved this to Review · 10:42", or "Codex changed 3 fields · 10:42". Expanding the task advances its `seen` cursor and clears the dot. Tasks the user creates start as seen. The dot is derived from history, so it appears at every autonomy level, including Full. A3's "mark" at Review is this same dot.

**The digest** is the Changes section on Today. It lists agent changes after the space's `digest` cursor, for tasks not shown elsewhere on Today, plus agent completions and agent-created tasks. Each line: the actor's monogram, one sentence with the task title as a link, and the time. Changes to one task collapse into one line ("Codex changed due and priority on _Book the moving van_"). Lines older than seven days drop off. At most five lines show. When there are more, the last line reads "More in Agents". Activating a title expands the task in place with its thread scrolled to the first new entry. Each line has Revert on hover and focus. The heading has one Clear button, which advances the digest cursor. The section hides until new changes arrive.

The **Agents** view is the full history: every session, run, routine and import, each expandable to its changes, with Revert per line and Revert all.

**Where the cursors live.** Both are UI conveniences, not space data. The service keeps them in machine-local UI state in A2's state folder (`ui-state.sqlite`: task ID → seen `(epoch, incarnation, seq)`, plus one digest cursor per space), outside history and undo. One machine owns each space (D16), so per-machine state is enough in v1. Losing the file only shows the dots again. A cursor from another epoch or incarnation counts as unknown in the same way, never compared by `seq` alone. Two small UI-only calls write them, `ui.mark_seen` and `ui.clear_digest` (A3 3.2.3), which never enter the operation log.

### 3.15 Live updates

Built. The service side is `packages/service/src/http/ws.ts` and `feed.ts` (A2 3.8.4, `A2.3.8.http.feed`). The store is `packages/web/src/store/`: `core.ts` (snapshot, batches, cursor), `pending.ts` (own writes), `frame.ts` (per-frame batching), `client.ts` (socket and reconnect) and `queries.ts` (paged queries). It is plain code, with React only in `hooks.ts`. Its proof is a model-based property test (`A5.3.15.web.store.interleavings`, model in `packages/web/test/feed-model.ts`): through a network that loses, repeats, reorders and replays messages and slips in another space's, the core equals the model's visible state at its cursor or asks for a snapshot. Mutating any rule of the core must fail it, so a change to a rule changes the model too. `A5.3.15.web.store.service` checks the same against the service's own feed. Items 8 and 9 wait for the expanded task.

1. **Snapshot.** Each tab subscribes by ID to the space in its route and holds its own snapshot. Another space's message never lands. Preferences join the snapshot as an additive field (3.28).
2. **Batches** apply by coverage against the `(epoch, incarnation, seq)` cursor, whole or not at all. Rows arrive as compact rows as of the batch's end, so the client never re-implements operation semantics. A child's change (note, log entry, source) sets its task's `touched` to the commit's `seq`, as the service does (A1 3.5).
3. **Apply.** Snapshots, batches and errors share one queue, drained once per animation frame in arrival order, with a 1 s timer beside it because a hidden tab gets no frames. Each frame publishes one immutable state, so a burst of agent writes costs one render.
4. **Own writes** are overlays on the confirmed rows, never mixed into them. A write settles only through the feed: an applied event carries its `request_id`, or the applied cursor covers its answer's `as_of`. The HTTP answer alone never confirms. The add field shows no optimistic row, because a row without an ID or reference cannot offer a working tile or Copy.
5. **Gaps.** A gap, another epoch or incarnation, a withheld row (`row: null`) or a batch the page cannot read in full takes a fresh snapshot and keeps scroll, the expanded task, focus and drafts. Gaps are judged by coverage, never by consecutive `seq` values, because a filtered feed skips operations.
6. **Focus is sacred: nothing moves under focus.** One rule covers every case (`withHeld` in `src/list/List.tsx`): while a row holds focus it keeps its place (inside its own list too, when an update re-sorts that list), its group and its element, with its latest data, and it keeps the tab order. When focus leaves, it goes where the view puts it. A new case belongs in this rule, because patching cases one by one leaves the next one open. The list, not the view, draws the empty line, so a view's last row can stay while it holds focus. Across every update the focused row, or else the first visible row, keeps its place on screen, with `overflow-anchor: none` so the browser does not anchor a second time.
7. **New rows** from agents fade in with `accent-soft` for 1.2 s, a static highlight under reduced motion.
8. **Expanded task.** Built (`task/useDetail.ts`). Its detail refetches when a frame touches it (`onTouched`), and only the newest read applies. New thread entries append at the end.
9. **Editing in progress.** Built for the title, who it waits on and the date popover (3.11): if a field the user is editing changes remotely, the editor keeps the typed value and shows "Changed by Codex just now", and its save is a conflict that keeps the person's value with Apply mine.
10. **Screen readers.** Agents' changes to the current view's tasks are announced once after 2 s of quiet, per actor, in a polite region ("3 tasks updated by Codex"). New thread entries in the expanded task are announced politely.
11. **Reconnect** resumes from the applied cursor with a new ticket and backs off (`client.ts`). A close with 4401 shows the signed-out bar (3.16) and never retries. Sign-out stops the store and drops its queue, so a snapshot waiting for its frame cannot make the tab live again, and a stopped store is never restarted. The feed's own traffic is no use of the token, so an untouched open tab is signed out when the token expires (A2).
12. **Service update.** Another build in `hello`, or a 409 with `data.reason = build`, shows the bar "Tasks was updated · Reload". The UI never reloads by itself, so drafts are safe.

**Paged queries.** Completed tasks, search results, Trash and the Agents history are not in the live store. They are read in pages and invalidated by **query**, not only by the rows they show. `PagedQuery` in `store/queries.ts` decides this for Completed, Search and Trash, with the read injected because the service has no paged read yet (`A5.3.15.web.store.queries`). TanStack Query may go behind its `PageSource` later. Still to build: Agents (new entries prepend, expanded entries keep their place), task detail (item 8), and a restarted Completed list that keeps focus and scroll on the same task and fades new rows in. A restarted query never drops the focused row before focus leaves (item 6).

Invalidation is written in the feed's **logical field** names (A1 3.4: `due` covers the three due columns, `lifecycle`, `wrap`, `deleted`), never in column names. A column name in their place would let a deletion miss Trash and leave a cleared due date on a shown row. The page's map `TASK_FIELD_COLUMNS` (`store/rows.ts`) is held equal to storage's by `packages/web/test/live-store.test.ts`.

### 3.16 Empty states and errors

**Empty states** are one short muted line where the list would start. They never instruct, illustrate or offer a button.

| Screen | Line |
|---|---|
| Today, nothing selected | "Nothing planned." |
| Inbox (direct URL only) | "Inbox is empty." |
| Open, Waiting, Review, Backlog | "Nothing open.", "Nothing waiting.", "Nothing to review.", "Backlog is empty." |
| Completed | "Nothing completed yet." |
| Agents | "No sessions or runs yet." |
| Search | "No matches." above the Add row |

**Loading.** Skeleton rows only if data takes more than 300 ms. No spinners on lists.

**Errors.**

| Situation | Behaviour |
|---|---|
| Service unreachable for 3 s | A bar under the top bar: "Reconnecting". Controls become read-only (`aria-disabled`). Drafts stay |
| Unreachable for 60 s | The bar reads "Tasks service is not running · Details". Details shows `tasks service start` and `tasks doctor` (A2 3.3.6). The UI never starts the service (R6) |
| Page loaded while the service is stopped | The browser's own connection error. There is no cached shell. `tasks service start`, then `tasks open`, recovers |
| Token expired or revoked: an API 401, or the feed closed with 4401 | A bar: "This window is signed out · Run `tasks open`". Drafts stay. The page never asks for a password or a code |
| A mutation is rejected | A sticky error toast with A3's message and one action ("Reload", "Details") |
| A network retry | Mutations retry with the same request ID, so a retry never doubles a change (R3) |
| Version conflict | In place, as in 3.11 |
| Launch failed or unknown | Thread entry and error toast (3.9) |
| Space is read-only (another authority, a migration needed, a migration that failed and is not tried again by this build, a newer format, a network file system, a synced folder not confirmed as excluded, a folder the check could not read, a failed integrity check) | A bar: "This space is read-only · Details". Details shows the service's own message, which names the reason and the way out (A1 3.2, 3.17), for example `tasks space open <folder> --excluded` or `--retry-migration`. Editing controls are disabled |
| Place missing | Folder and launch Unavailable, with "Choose folder" in the expanded task. Never a parent folder or another clone (R11) |
| Unknown event or field from a newer service | The client takes a snapshot. If the build IDs differ, it shows the reload bar |

### 3.17 First-run setup

A centred column (max 560 px) outside the normal frame, at `/setup/:step`. Each step has a small title, its content, and Back, Skip and Continue. Progress is a row of dots, labelled "Step 2 of 7" for screen readers. Steps 0 and 1 are required. Every later step can be skipped and is reachable again from Settings.

| Step | Content |
|---|---|
| 0. Before you start | A6's "use at your own risk" paragraph and Continue. Shown once, never as a recurring banner |
| 1. Space | Name the space ("Work", "Personal"). Location `~/.tasks/spaces/<slug>` (`%USERPROFILE%\.tasks\spaces\<slug>` on Windows), editable. Or "Open a space folder". Or "Try the sample space", a separate folder built from the fixture, never mixed into a real space. The step names the data folder `~/.tasks`, because it is hidden. The machine name is prefilled from the hostname |
| 2. Autonomy | Three choices: **Full**, **Review** (preselected, A3) and **Suggest**. One line of help each on hover and focus: "Agents change and complete tasks directly", "Agents change tasks with a mark. Completions wait for you", "Agents only propose". A6's risk text sits next to Full. Plus a switch: "Agent-created tasks go to Inbox" (off for Full and Review, on for Suggest) |
| 3. Agent apps | The instances A4 detected ("Found a second Codex home, `~/.codex-alt`. Add it?"), each with a checkbox, an editable label naming the account, its monogram and ring, the version found, its config home in mono and its permission mode. A6's risk text appears once when any selected instance uses full access. A radio button picks the default instance. Two instances with the same monogram and ring are refused with a suggested ring. Nothing is added without a tick |
| 4. Connect | For each selected instance, the **MCP registration preview** of `tasks setup agents` (A3 3.13.1): the file as a header, the exact command the app's own `mcp add` runs, and the key-level diff in mono. The optional instruction block for `AGENTS.md` or `CLAUDE.md` is a separate, unchecked item with its own diff (D15). For a managed instruction source, the step shows the text with a Copy button instead of a diff. Apply runs the same setup engine as the CLI, in the service once it has A4 3.8's agent environment, because the apps' commands must be the ones on the person's PATH. It is bound to the preview it shows by the preview's plan token, so it refuses and changes nothing when a home changed since. It lists what changed. Nothing touches another app's trust settings (R16). A home setup refuses (a file or folder that is a link, that another user owns or that every user can write, a managed or unreadable file, an entry of the product's name it did not write) shows why in place of a diff. When Claude Desktop has several configuration files, the step asks which one the app uses, as the CLI's `--home` names it (A3 3.13.3). Each instance then shows a check result from `tasks doctor` (configured, or the reason it is not) |
| 5. Folders | Detected roots (`~/work`, `~/oss`, `~/src`), each with a name. Roots name the places of tasks (A1, A4) |
| 6. Import | The Planning prototype importer (A7) with its preview and report, or "Start empty" |

Then Today opens. A new space shows the strip and "Nothing planned." No starter tasks, tours or coach marks. Settings offers "Set up areas with an agent", which opens the default instance with an onboarding brief, so agents choose the areas for the user's kind of work.

### 3.18 Settings and feature flags

Settings live at `/s/:space/settings/:section`, opened with the gear or `Ctrl+,`. Each section is one short page with no explanatory paragraphs. Every setting's tooltip names its preference key ("ui.theme"), because agents and the CLI can change preferences too. Changes apply at once and are undoable.

| Section | Contents |
|---|---|
| General | Theme (Sumi, Washi, System), density (comfortable, compact), language, week start, landing view |
| Today | Week strip on or off, Next limit, Changes on or off |
| Features | One switch per feature flag |
| Agents | Autonomy, Inbox for agent tasks, instances on this machine (label, monogram, ring, account, permission mode as A4 reports it), pinned instances and their order, default instance per space and per area, "no agents" per area, reset of first-Run confirmations. Choosing a full-access permission mode shows A6's risk text once |
| Connections | MCP registration and instruction block per instance, with status, "Set up again" (the step 4 preview) and Remove, which takes back only an entry that is still exactly setup's (A3 3.13.1) |
| Routines | Each routine: instance, brief preview, Run, last result. Scheduling appears here when it ships (D8) |
| Folders | Machine name, roots, and this space's Tasks work folder on this machine (path read-only, with Open folder) |
| Keyboard | Single-key shortcuts (on, off, require Alt), remapping, the shortcut sheet |
| Data | Markdown projection, export, import with preview, backups, and Trash (deleted tasks with Restore), all from A1 |
| About | Version, the data folder, the `tasks doctor` summary, licences |

Built so far: the one section `appearance`, which holds the theme (3.19). The sections above replace it, and the theme moves to General.

Autonomy, instances, routines, roots and connections are policy. Agents cannot change them (R7). Their pages carry a small lock glyph with the tooltip "Only you can change this".

No action removes a person's data or a backup as a side effect. What an action replaces is retired and kept, and the result says where it is. Removing anything outside the stated retention policy (purging Trash, deleting a backup or a retired copy) is its own explicit action.

**Feature flags** are space preferences `features.<flag>` in A1's registry. A disabled feature removes its UI completely: no greyed buttons, no placeholders, no shortcuts. Its data stays and remains available to agents. The launch slot is the one exception: it keeps its width so columns align.

| Flag | Default | Removes |
|---|---|---|
| `week_strip` | on | The strip on Today |
| `next` | on | Today's Next section |
| `changes` | on | Today's Changes section (the row dots stay) |
| `age` | on | The age column |
| `effort` | on | The effort fact and its key |
| `priority` | on | The priority mark, fact and keys |
| `learnings` | on | Related learnings in the expanded task |
| `background_runs` | on | Run in the strip and `Shift+R` |
| `agents_view` | on | The Agents view (sessions and runs still show in threads) |

### 3.19 Themes and tokens

Built, in `packages/web/src/theme/`: the token allowlist, the contrast pairs and theme validation in `tokens.ts`, the values in `sumi.json` and `washi.json`, the choice in `preference.ts`. Tests: `A5.3.19.web.theme-data`, `A5.3.19.web.contrast`, `A5.3.19.web.styles` (`packages/web/test/styles.test.ts`) and the screenshots `A5.3.19.e2e.screens`.

**Tokens.** Every visual value is a CSS custom property `--k-<token>`, and components use tokens only. The style check refuses a raw colour outside the theme data, uppercase or capitalised text, letter spacing above 0.01em, and a hairline token used as a text colour. **Sumi** (dark, the default) is sumi ink and unbleached paper with one moss accent. **Washi** (light) is warm paper. The colours have names the rest of this appendix uses: moss `accent` (primary action, focus marks, the changed dot, today's underline), ochre `due` (due within six days), persimmon `late` (late, errors), indigo `waiting`, wisteria `review` (review, proposals, the needs-input ring) and gold `star`. Each state colour has a `-soft` fill for chips. `raised` is the expanded task, popovers and the active sidebar item, `sunken` the composer field, `selected` a selected or filtered day, `accent-soft` the new-row flash and search matches. `line` and `line-strong` are decorative hairlines. `control` (checkbox, outlined controls, editable facts) meets 3:1.

**Themes are data.** Sumi and Washi load through `validateTheme` like any later theme. The build writes their custom properties into the one stylesheet (`virtual:theme-tokens.css`), so the stylesheet and the contrast test read the same values and no runtime style or flash is needed. Sumi needs no attribute. `data-theme="washi"` picks Washi, and `data-theme="system"` follows `prefers-color-scheme` live in CSS alone, with Sumi when the browser gives no signal. Dark stays the default (D17). The choice is kept per browser in `localStorage`, read as untrusted, until `pref.set` and the snapshot's preferences exist (open item 15).

**Contrast** (WCAG 2.x), for every theme against the five surfaces `bg`, `raised`, `hover`, `selected` and `sunken`: 4.5:1 for text, 3:1 for marks, controls and focus, plus the named pairs in `ALLOWED_PAIRS`. The thinnest margins are Washi's `muted` and area slots and `control` on `accent-soft`. Hairlines and `late` against `due` (about 1.2:1) must never carry meaning (`DECORATIVE_PAIRS`), so late and due-soon always differ by text and by a glyph.

**Area colours.** An area stores a colour slot from 1 to 8 in A1's `areas.color`, never a hex value, so a theme switch keeps the mapping (open item 8). An area without one takes its place in the order, wrapping after 8. Area colours appear only as dots and marks, never as fills. Instance rings use the same eight slots.

**Later themes** (not in v1) are token data, `{name, base: "sumi" | "washi", tokens}`, stored where the theme choice lives (open item 15). They are validated on write: only allowlisted token names, colours only as `#rrggbb`, font families only from the bundled set or `system-ui`, radii 0–16 px. Themes are data, never CSS, so they cannot inject styles or scripts. The contrast check runs over a theme on load. A failing theme still loads, and Settings lists the failing pairs. A new theme needs no code change.

### 3.20 Type, spacing, icons and motion

**Fonts**, built. Inter for the interface and Fira Code for paths, IDs, code and diffs (both SIL OFL 1.1), bundled as the Fontsource variable faces (`src/main.tsx`) and served from the app origin, so no font request leaves it and every OS renders the same (U16). Ligatures are off in the UI, so paths show their real characters. The fallback stacks are in `src/theme/base.css`. Themes may set `font-ui` to `system-ui`. The version folder's `THIRD_PARTY.txt` (A2) names every shipped package with its licence, and the build test checks it.

**Type scale** (rem, base 16 px, so OS and browser text size apply):

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `t-title` | 14 / 20 | 500 | Task titles |
| `t-body` | 14 / 21 | 400 | Context, thread, sidebar, buttons, facts |
| `t-small` | 13 / 18 | 400 | Summary line, project labels |
| `t-group` | 14 / 20 | 600 | Area headings |
| `t-section` | 12.5 / 18 | 500 | Today section headings, muted |
| `t-meta` | 12 / 16 | 400 | Due, age, times, counts. Tabular figures |
| `t-label` | 12 / 16 | 400 | Fact labels, muted |
| `t-mono` | 12.5 / 18 | 400 | Paths, keys, diffs |
| `t-mark` | 10 / 12 | 700 | Monograms only |

Weights 400, 500 and 600 only, and 700 for monograms. No uppercase and no letter spacing above 0.01em (the style check of 3.19).

**Spacing.** A 4 px base: 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px (`s-1` to `s-11`). Rows: 52 px minimum (comfortable) or 44 px (compact, which keeps the summary line). Radii: 4 (keys), 6 (small buttons), 8 (buttons, inputs), 12 (expanded task, popovers), pill (chips, fact buttons).

**Icons.** One set on a 24-unit grid with a 1.6 stroke, round caps, no fill (except the filled star), inheriting text colour. Shapes are adapted from Lucide (ISC) and compiled into a sprite served from the app origin. Icons are never loaded from space data. No vendor logos: instances show monograms, which avoids trademark use. Until the sprite exists, the shell's few icons are inline components. Every icon-only button has an accessible name from the catalogue, and the same string is its tooltip.

| Group | Icons |
|---|---|
| Views | today (sun), inbox (tray), open (list), waiting (hourglass), review (eye), backlog (layers), completed (check circle), agents (terminal), settings (sliders) |
| Row | star, folder, folder-elsewhere, person (waiting chip), late (clock) |
| Source kinds | mail, chat, ticket, pull request, issue, document, calendar, crash, book, session, link |
| Actions | plus, refresh, run, stop, copy, note, revert, undo, accept, reject, chevrons, close, calendar, learning (bulb), outcome, lock |

**Motion** confirms an action. It never decorates. Easing is `cubic-bezier(.2, 0, 0, 1)`, with no bounce, scale or parallax.

| Event | Motion | Duration |
|---|---|---|
| Hover, press | Background colour | 120 ms |
| Expand, collapse | Body height and opacity. The title does not move | 180 ms |
| Check-off | Fill, strike-through, 4 s hold, then height to 0 | 120 ms, 4 s, 180 ms |
| New row from an agent | Opacity in, accent-soft background fades | 180 ms, 1.2 s |
| Popover, tooltip, toast | Opacity and a 4 px offset | 120 ms |
| Live dot, Connected ring | Opacity 1 → 0.4 → 1 | 2 s period |

Under `prefers-reduced-motion: reduce`, every animation and transition takes no time (the 4 s check-off hold and the toast timers stay), pulses become static rings, flashes a static 1.2 s highlight, and smooth scrolling instant.

### 3.21 Keyboard

Single-letter keys work only when focus is not in a text field or an IME composition. Modifier shortcuts work everywhere unless noted. On macOS `Ctrl` reads as `Cmd`. Letters match `event.key`, so mnemonics survive other layouts. Digits match `event.code`, so they work on AZERTY.

| Scope | Keys |
|---|---|
| Global | `/` search · `n` new task · `Ctrl+K` top field · `g` then `t` Today, `i` Inbox, `o` Open, `w` Waiting, `r` Review, `b` Backlog, `c` Completed, `a` Agents · `Ctrl+,` settings · `Ctrl+Z` undo · `Ctrl+Shift+Z` or `Ctrl+Y` redo · `F6` cycle sidebar, main and toast · `?` shortcut sheet · `Esc` closes the innermost tooltip, popover, editor, drawer or expanded task |
| Rows | `j`/`k` or arrows move · `Home`/`End` · `[`/`]` previous or next group · `Enter` expands or collapses · `x` done · `Shift+X` drop · `s` star · `1`–`3` priority, `0` clears · `e` effort · `d` due · `w` waiting · `b` backlog · `o` back to open · `a` area · `l` open in the effective instance · `Shift+L` focus the strip with digits on its buttons · `Shift+R` run (first Run asks once) · `f` open folder · `m` focus the composer |
| Composer | `Enter` note · `Shift+Enter` newline · `Ctrl+Enter` open in the default instance · `Ctrl+Shift+Enter` run (the first Run per instance asks once) · `Esc` leave the field and keep the draft |
| Review | `y` accept · `Backspace` reject (on a focused proposal) |
| Editors | `Enter` apply · `Esc` cancel · arrows and `PageUp`/`PageDown` in the calendar |

Built so far: the list's moves (`j`/`k`, arrows, `Home`/`End`, `[`/`]`) and `Esc`, which collapses the expanded row from anywhere inside the list and focuses its title (`A5.3.22.web.list-keys`), and `F2` on a row's title, which edits it in place, where every key is the field's (`A7.3.12.m5-06.e2e.keyboard`). The other single keys arrive with `ui.keys.single` and the keymap.

There is no single-key Run, so a stray keystroke cannot start a background run with full permissions. Run needs `Shift+R` on a row or a two-modifier chord in the composer.

**Turning keys off.** The preference `ui.keys.single` is `on` (default), `off`, or `alt` (each single key then needs `Alt`), per WCAG 2.1.4. Settings › Keyboard remaps any action and flags conflicts inline. The shortcut sheet and tooltip hints are generated from the same keymap the handlers use, so they cannot drift.

**Firefox.** A page can take `/`, single letters, `Ctrl+K` and `Ctrl+Enter` with `preventDefault`, which also stops Firefox's quick find. Shortcuts Firefox reserves (`Ctrl+T`, `Ctrl+W`, `Ctrl+N`, `Ctrl+Tab`) are never used. M0-2 (section 5) confirms this in real Firefox.

### 3.22 Accessibility

Target: WCAG 2.2 AA from the first UI milestone. A full audit before 1.0.

- **Landmarks.** `nav` (sidebar), `header` (top bar), `main` (view). A skip link to the main list.
- **Lists.** Each view is a `ul`. Area and project groups are `role="group"` named by their title through `aria-label`, not `aria-labelledby`, because a virtualised list may have unmounted the heading. Each project's rows are a `ul` whose `aria-posinset` and `aria-setsize` count against that list's true size. Today sections are `section` elements with `h2` headings, named by `aria-label` like the groups.
- **Row pattern.** The title is a `button` with `aria-expanded` and `aria-controls`. The checkbox (`input type="checkbox"`, "Done: <title>"), star, source links, folder and launch tile are siblings of the title, never its children. A roving tabindex puts only the focused row's title in the tab order. `j`/`k` move it, and `Tab` walks the row's other controls.
- **Row description** (`aria-describedby`), built by the row function in a fixed order: project (when shown), status (when not implied), due ("due Friday 13 November"), priority (P1–P3 only), age ("created 10 November"), starred, marker ("changed by Codex", "needs your input"), launch state.
- **Expanded task.** `role="region"` labelled by the title. Facts are a `dl`. Segmented controls are `radiogroup`s. The strip is a `toolbar`. The date popover follows React Aria's date-picker pattern, with the text field as the primary input.
- **Virtualised lists** keep `aria-setsize` and `aria-posinset` on rows, so screen readers announce the true size. Lists of 200 rows or fewer are not virtualised. Browser find (`Ctrl+F`) cannot see unrendered rows, so `/` search covers every task.
- **Live regions.** Toasts and status bars use a polite region. Errors use an assertive one. Burst summaries follow 3.15.
- **Focus.** A 2 px `focus` ring on every focusable element via `:focus-visible`, offset 2 px from accent fills. `scroll-padding` keeps focused rows clear of the top bar and the sticky composer. Check-off moves focus to the next row. Popovers return focus to their trigger.
- **Hover equals focus.** One tooltip component shows on hover after 500 ms, at once on keyboard focus, and after a 500 ms long press. It is dismissible with `Esc` and hoverable (WCAG 1.4.13). Every action shown on hover is also shown on focus. Until that component is built, the row writes each tooltip's text into `data-tip`, and the names and descriptions carry it for assistive technology.
- **Colour.** Never the only signal: due text, status chip text, marker shapes, diff glyphs, monograms with labels.
- **Targets.** At least 24 × 24 px (WCAG 2.5.8).
- **Text and zoom.** All sizes in rem. Works at 200 % zoom and reflows to 320 CSS px.
- **Forced colours.** In Windows high-contrast mode, controls use system colours, focus uses `Highlight`, and markers keep their shapes.
- **Reduced motion.** As in 3.20.

### 3.23 Internationalisation

- **Message catalogues**, built. ICU messages in `packages/web/src/i18n/<locale>.json`, through FormatJS (`react-intl`). `en.json` is the source, and message IDs are typed from it, so nothing is extracted. Plurals and selects go through ICU, never string concatenation. `useT()` (`src/i18n/intl.tsx`) gives every message the product's and the CLI's names from `packages/brand`, so no message names the product. Test: `A5.3.23.web.catalogue`.
- **Two lint rules** in `pnpm verify` keep UI words in the catalogue (`eslint.config.js`). `formatjs/no-literal-string-in-jsx` reads only JSX, so words kept in a variable or built in a `.ts` module would pass it. `noUiProse` therefore refuses prose (two words with a space between) in any string or template stretch of the page's code. A single word in a variable, or words split around a template's placeholders, are left to review, because telling them from identifiers needs types the lint does not have. Tests: `A5.3.23.lint.literal-strings`, `A5.3.23.lint.ui-prose`.
- **Locales.** `en` is the source and the only locale built. A pseudo-locale (accented and 35 % longer) is to run in CI to catch hard-coded strings and truncation. Dutch is the first real translation.
- **Dates and numbers** through `Intl`. The compact forms ("Sat 14", "2d late", "3w") are catalogue messages over `Intl`'s names, so the order is per locale while `en` keeps the British forms. Times use `h23`. Due dates are local calendar dates and timestamps are UTC (A1).
- **Week start** from the preference, then `Intl.Locale` week info where available, then Monday.
- **Natural dates** through chrono-node 2.10 (full for English, Dutch, French, Italian, Japanese, Russian and others, partial for German, Spanish, Portuguese and Chinese). The app's own shortcuts (`tod`, `+3d`) are defined per locale.
- **Layout.** CSS logical properties only. Directional icons mirror under `dir="rtl"`. User content gets `dir="auto"`. Labels survive 40 % expansion. Instance labels are 1 to 40 characters, the strip shows the first 14 (A4 3.2), and the accessible name carries the whole label.
- **Sentence case** is an English style rule. Other locales follow their own casing, and nothing relies on CSS case transforms.
- **Shortcuts** keep English mnemonics by default in every locale and can be remapped.

### 3.24 Frontend stack

Every library is pinned exactly in `packages/web/package.json`. A library marked "to add" arrives, pinned exactly, with the first screen that needs it.

| Concern | Choice | Why |
|---|---|---|
| Framework | React with strict TypeScript | React 19.3 or later supports Trusted Types, which the CSP requires (3.26) |
| Build | Vite | Plain ESM output that the service serves as static files |
| Routing | TanStack Router | Typed routes and typed search params (`?q=`, filters) |
| Live state | The live store on `useSyncExternalStore` (3.15) | Holds the open working set. View derivations are memoised selectors. No state library |
| Request data | TanStack Query, to add | Task details, threads, completed pages, search and settings, with event-driven invalidation |
| Virtualisation | TanStack Virtual | Dynamic row heights and scroll anchoring |
| Accessible controls | React Aria Components | Popover, Tooltip, Toolbar, RadioGroup, ToggleButtonGroup, DatePicker and Calendar with i18n, Dialog, ComboBox. The task list is custom, because a row holds several independent controls |
| Styling | CSS Modules plus the theme's custom properties | No runtime CSS-in-JS. React Aria inserts one runtime `<style>` and reads its nonce from `<meta name="csp-nonce">`, which the service fills per response, so `style-src` needs no `unsafe-inline` |
| Fonts, messages | Fontsource variable faces, `react-intl` with `eslint-plugin-formatjs` | 3.20, 3.23 |
| Markdown | `markdown-it` with HTML disabled, then DOMPurify, to add | Agent and source text is untrusted (3.26) |
| Date parsing | chrono-node 2.10, to add | Natural dates in capture and the due popover |
| Icons | Own SVG sprite, shapes adapted from Lucide (ISC), to add | One stroke style, no icon font, served from the app origin |
| API types | A3's generated client and `contracts` types | The UI never hand-writes API types. `pnpm verify` fails when the generated files are stale |
| Unit and component tests | Vitest, happy-dom for tests that render React | React's `act` drives the renders, so no Testing Library |
| End-to-end, visual, accessibility | Playwright, with `@axe-core/playwright` to add | Firefox and Chromium. axe-core's MPL-2.0 licence is fine for a development dependency |

No server-rendering framework (the UI is a local client of the service), no Redux (the live store is small and event-driven) and no Tailwind (a utility-class vocabulary would leak raw values into components and break themes as data).

**The build** (`packages/web/build.ts`, `pnpm build:web`; tests `A7.3.9.m2-13.web.build` and `A7.3.12.m5-01.web.build`) keeps the CSP exact: one script and one stylesheet, no inlined `data:` asset, integrity hashes on everything `index.html` loads, and the service's two placeholders in `index.html` (3.28). It uses Vite's own TSX transform, without `@vitejs/plugin-react`, which adds Babel and fast refresh that a production build does not use. **A build never carries a path of the machine it was built on**, so it is always a production build: it runs Vite with NODE_ENV set to `production` and gives the caller's value back after. NODE_ENV belongs to the whole process, so builds in one process run one at a time. Vite decides from NODE_ENV, not from `mode`, and a development build's JSX names every component's source file by its absolute path (test `A5.3.24.web.build-paths`). The build refuses a second script, because a lazy chunk loaded through `import()` carries no integrity hash. **The first lazy chunk** (Settings, setup, the date picker, 3.25) therefore comes with an import map that gives each chunk its `integrity`. The service allows that inline `<script type="importmap">` by its SHA-256 in `script-src`, computed from the served `index.html` it already checks. The fallback is a `modulepreload` with `integrity` per chunk. Either way the service's `indexProblems` must cover it.

**Names and imports.** The page takes every name from `packages/brand` and imports only `packages/contracts` and `packages/brand` (dependency rule `web-only-contracts`).

**Stored values are untrusted.** Anything read back from `localStorage` is untrusted input: a token is used only when it has the token shape, and anything else is removed and signs the tab out (`src/stored.ts`, `A5.3.26.web.stored-token`). A draft renders as plain text.

**Code layout.** `packages/web/src/` holds `app/` (shell, router, space session), `store/`, `list/`, `row/`, `task/`, `views/`, `theme/` and `i18n/`. Still to come: Facts, Links and ProposalCard in `task/`, one module per view in `views/`, `composer/` (Composer, Strip), `editors/` (DuePopover, Segmented, TypeAhead), `icons/` (the sprite) and the `nl` and pseudo catalogues. Nothing is fetched from the internet at runtime.

**PWA.** The build writes a web app manifest and its icons, so Chromium-based browsers can install the UI as an app window (D3). The icon is a placeholder until the brand's icon exists. Chromium installs it without a service worker, and v1 registers none (U27, 3.26). Firefox has no desktop install, and nothing depends on it. An offline shell can return after M10's authenticated origin exists.

### 3.25 Performance

Targets hold on the Linux reference machine (Ubuntu 24.04, Firefox snap) with a seeded space at A1's **design scale**: **5,000 open tasks** and 50,000 completed, 30 areas and 200 projects, with 10 agent sessions writing and the service already running. A1 owns these numbers. Its larger stress corpus is for A1 and A3's query budgets, not for these targets.

| Measure | Target |
|---|---|
| Today interactive after page load | ≤ 800 ms |
| Open-set snapshot | ≤ 1.5 MB uncompressed, ≤ 300 KB compressed (about 250 bytes per compact row) |
| View switch (derive, group and render the visible rows) | ≤ 100 ms |
| Scrolling the Open view | 60 fps |
| Check-off, star, priority (input to paint) | ≤ 50 ms p95, optimistic |
| Expand a task (detail fetch and render) | ≤ 120 ms p95, of which `get_task` is A3's 50 ms |
| Apply a burst of 100 events | ≤ 16 ms of script work, and the frame that holds it is not late |
| Search results painted after the `search` reply | ≤ 50 ms (the call itself is A3's budget) |
| Live updates while 10 agent sessions write | No frame over 16 ms of main-thread work. The focused row never moves |
| JavaScript heap at 5,000 open tasks | ≤ 200 MB |
| Initial JavaScript | ≤ 250 KB compressed. Settings, setup and the date picker are lazy-loaded |
| Fonts | ≤ 200 KB, Latin subset first |

**The burst rule** is judged on every burst, not a p95. Each burst runs inside a `requestAnimationFrame` callback and passes when its script work stays at or under 16 ms and the interval to the next frame stays within one refresh period plus 5 %, which covers style, layout and paint.

**How the design meets them.** Completed tasks are never in the live store. Derivations (Today, groups, counts) are memoised per view and recomputed only for the tasks an event touched; today the list still derives every item when the store publishes, and M5.13 measures that against the burst rule. Rows are memoised and every prop a row takes keeps its identity, so a store update that touches one task renders that row only and scrolling renders no row (`A5.3.25.web.render-count`, which fails when `memo` is removed).

**The list** (`src/list/List.tsx`, `items.ts`) is one sequence of items, group headings and project labels included. Over 200 rows it is virtualised with TanStack Virtual against the window, with 10 items of overscan each way. Both modes render the same structure with the same keys, so a list that crosses 200 keeps its rows and focus. The current, focused and expanded rows always stay mounted. Offsets are custom properties written through the CSSOM, never a style attribute, so the CSP holds. TanStack's `directDomUpdates` stays off, because the scroll anchoring of 3.15 item 6 must know every offset. Size estimates are never taller than the real heights. Tests: `A5.3.25.web.items`, `A5.3.25.web.render-count`, `A7.3.12.m5-03.e2e.scroll-5000` (5,000 rows, every frame of a full sweep covered with focus kept) and `A7.3.12.m5-03.e2e.rows`.

**Still to build:** the Playwright performance test over this table, in CI (Chromium and Firefox on Linux) and on the Linux reference machine at each UI milestone.

**Measured so far** (M0 lab row U07, 5,000 rows, headless Firefox 159): 60 fps scrolling, view switch p95 23 to 24 ms, burst script work 12 to 15 ms with no late frame. The stack needs none of M0-4's fallbacks. The burst has little margin, and the spike re-derived all 5,000 tasks per burst where the product derives per event. The visible run in the Firefox snap is still open (M0-4); a miss there reopens the stack choice before M5.13. Headless Firefox keeps a 1366 × 768 window and reports `performance.now()` in whole milliseconds, so headless numbers are coarse.

### 3.26 Rendering untrusted content

Task text comes from agents and from emails, tickets and chats, so it can carry injected markup or prompts. One script injection in the UI could call the launch API, which amounts to code execution. These rules implement A6's UI part.

- **CSP**, built. The service sends it on every response (`packages/service/src/http/csp.ts`, A2 3.8.3; tests `A2.3.8.http.csp`, `A2.3.8.http.listener` and `A7.3.12.m5-01.e2e.strict-csp`). The UI lives within it: everything from the app origin, a WebSocket to the same port, no worker, and styles only from files or with the per-response nonce (3.24). `wasm-unsafe-eval` is reserved for the later phone client's WebAssembly crypto (A6), never the v1 UI.
- **Trusted Types** are enforced in Chromium and Firefox. The UI uses no inline scripts, no `eval` and no `dangerouslySetInnerHTML` outside the sanitiser wrapper. A test that a service worker is refused must use a trusted URL, because Chromium's Trusted Types refuse a plain one before `worker-src 'none'` is reached.
- **Origin trust in v1.** The browser knows the UI only by `http://127.0.0.1:<port>`. If another local user binds that port while the service is stopped, a reload runs their page under the same origin, with access to the token and drafts in `localStorage`. v1 **assumes a single-user machine**. The UI's part is to register no service worker, so nothing cached can be replaced. The service's part (token expiry, revoking UI tokens when another user holds or held the port, the `tasks doctor` warning) is A2's (3.8.2, 3.13). **M10 (public release) cannot pass without an authenticated UI origin** (open item 6). The UI only runs under it.
- **Plain text** for titles, summaries, source titles, people and labels, through React's escaping.
- **Markdown** (context, notes, log, outcome, learnings, run replies), built (`task/markdown.tsx`, `A5.3.26.web.markdown`), is parsed straight into React elements of an allow-list: paragraphs with their line breaks, `#` lines as strong lines (no heading elements), lists, quotes, fenced and inline code, emphasis and links. It is never HTML: raw HTML shows as the text it is, React escapes every string, and nothing reaches `innerHTML`, so there is no sanitiser to trust and Trusted Types are never asked. No images, SVG, iframes or style attributes from content. Parsing takes time linear in the text: no pattern lets two unbounded quantifiers compete for the same characters, and a heading's marks are found by plain scans.
- **Links**, following A6. `https:`, `http:` and `mailto:` become links that open in a new tab with `rel="noopener noreferrer"`. App schemes of configured targets (a T3 thread link) are clickable and only open that app. They never carry a brief, because launches come only from the app's own buttons. `file:` links and local paths render as text with Copy and a Reveal that goes through place resolution. Anything else renders as plain text.
- **No remote content.** No remote images, fonts or scripts. Source favicons and avatars are not fetched.
- **Hidden characters** (tag characters, bidirectional controls, zero-width spaces, word joiners, in-text byte-order marks) are stripped on write (A3 `SafeText`, A6 3.16.2). ZWJ and ZWNJ stay, because emoji and some scripts need them.
- **Source-derived text** looks different from the user's own notes (actor marks in the thread, source lines with kind icons), so content from an email never looks like an instruction from the user.

### 3.27 The mockup

`A5-mockup.html` is a static, self-contained page that opens from disk with no network or scripts. It shows Today at 1,440 px in the Sumi theme with the fixture content of 3.4: the sidebar, the top bar, the week strip, Focus with "Fix appointment time zones" expanded in place (context, sources, folder, a related learning, the thread, the facts and the composer), This week, Next and a one-line Changes digest. It uses the real app's font stacks and falls back to system fonts when Inter and Fira Code are not installed.

**Where the mockup is behind, this specification wins.** Rows without a folder (Sign the lease, Dentist check-up, Book the moving van) show the Copy glyph in the launch slot. Under 3.6 and 3.8 they show the effective instance's monogram (Ready, opening in the Tasks work folder), and the folder slot stays empty until that folder exists. The mockup is updated to match when it is next edited.

### 3.28 The interim shell and the service's UI seams

Built, in `packages/service/src/http/`. The service keeps a minimal shell of its own (`builtinUi` in `page.ts`) for when no built page is given. **The built page** is a folder read once at start by `loadUiFolder`, which fixes the folder's contract and refuses an `index.html` that the CSP or the integrity check would not cover (`indexProblems`). The service fills `__TASKS_BUILD__` with its own build and the page sends it back on every call, so a page served before an update gets 409 and the reload bar (3.15 item 12).

**Requests** carry the token, the build and the tab's space. Header names come from `httpHeader()` in `packages/brand`, never from a display name, because `fetch` refuses a header name with a space.

**Open and Copy.** A tile calls A4's `launch.open` through the generated client, and Copy calls it without an instance. Both run on the hub's launch service, whose one launch machine per space also serves the shim's claim, recovery after a restart and the sweep, so a page click and a shim's claim act on the same intent. Each click has a fresh request ID, and a repeated one replays its launch and starts nothing. The page writes a returned brief to the clipboard inside the person's click. The UI's writer scope is its grant (`ui:<grant_id>`, A3 3.7.9), so request IDs and their receipts belong to one signed-in browser. The tiles are the launch service's `instances()` (`packages/service/src/launch/service.ts`): the enabled instances whose target has a route on this machine, with the ring slot by position. `POST /api/v1/launch/list` gives a task's last receipts (`http/launches.ts`). Tests: `packages/service/test/http-launch.test.ts`, `A7.3.9.m2-13.e2e.open`, `A7.3.9.m2-10.e2e.copy`, `A7.3.9.m2-13.e2e.races`.

**Still to add on the launch path:**

- 3.8's questions before dispatch. Today a click dispatches at once.
- The composer text in `launch.open`'s `text`, once the composer exists.
- T3. A T3 instance has no route until its Open connects the Register question and the binding at the click (A4 3.4.1), so it has no tile.
- The tile's Unavailable and Elsewhere states, taken from the same folder resolution that refuses a click (`LaunchFolderUnavailable`), so the tile and the click never disagree. The plan carries the task's place on this machine, or none for the work folder, never another machine's place.

**Still to add to the snapshot and `hello`:** preferences, the row data 3.6 still lists (sources and the place's state are carried), a way to reach the task of a launch entity (open item 11), and health in `hello`.

---

## 4. Weak points solved

Section 3 states the UI's guarantees against known failure modes where they apply. Two more:

- **No desktop shell in v1.** The browser-first UI needs no root for a sandbox. A later shell is a pure client of the same HTTP and WebSocket API and never adds `--no-sandbox` by default.
- **No live editable mirrors.** The UI is the editing surface. File edits come back only through the previewed import, which reuses the proposal card (3.10).

**v1 UI scope.** Today, Inbox, Open, Waiting, Review, Backlog, Completed, Agents and area views. Task links for every lifecycle. Search and capture. The row, the expanded task and the composer (Note, Open, Run, Copy), including the Tasks work folder for tasks without a place. Launch and run status, proposals, field editing, undo and revert, the changed marker and digest, live updates, Sumi, Washi and System, keyboard, first-run setup, settings and feature flags. No service worker. Later: saved views, recurring tasks and reminders, calendar views, bulk selection, drag reordering, the phone layout, linked machines and a theme editor.

---

## 5. Verification

The built parts carry their tests, named in their sections: the row function and tile (3.6), the live store and paged queries (3.15), the list (3.25), themes and the style check (3.19), the catalogue and its lint (3.23), the build (3.24), the shell and its routes (3.3), the strict CSP and integrity (3.26, 3.28). The page reaches the registry through contracts' generated client over HTTP, which is one of A3's contract suite faces (`packages/service/test/contract/suite.ts`). Test files create nothing at module level: every folder, service, world and store is made inside a test or its setup and removed in its teardown, so loading a file for discovery leaves nothing behind.

**Still to write, as the parts arrive.**

Unit tests (Vitest):

- Today selection: disjoint sets, ordering, the waiting rules, the day filter and the Next limit, over fixture and generated data (property test: no task in two sections, every selected task meets its rule).
- Due and age formatting across locales and time zones, including DST boundaries.
- The capture parser: dates, `p1`–`p3`, `#area/project`, `@person`, `*`, and ambiguous dates.
- Agents history invalidation (3.15), and task route resolution for every row of 3.3's host-view table.
- Priority editing: `0` and clicking the active segment set P4.
- Later themes: validation and the contrast report.
- The keymap: no conflicts, the sheet matches the handlers, single-key modes work.

Component tests (Vitest with happy-dom and React's `act`): segmented controls, the date popover, type-aheads, the composer keys (including IME composition), the proposal card and partial accept, the launch tile states and the run entry states, each driven by fake A4 states.

End to end (Playwright, Firefox and Chromium), against a real service with a seeded space:

- Repetition rules on every screen: the date appears once (only in the strip), counts appear only in the sidebar, a task appears once on Today, no element has `text-transform: uppercase` or letter spacing above 0.01em, no view has a heading element above the lists, and no expanded task shows the same fact string twice.
- Flows: capture → triage in Inbox → star → expand → edit due, priority and effort → note → check-off → undo → redo. Proposal accept and reject. Revert from the digest and from Agents. Undo conflict ("Restore mine").
- Launch and run with A4 fakes: each receipt and run state renders as in 3.9. Unknown never re-dispatches. Disabled reasons for a missing place, a missing instance and another machine.
- Tasks work folder: on a task without a place, click-to-ask, Open and Run reach A4 with the work folder, the confirmation names it, and the folder slot appears after first use. A task with a missing place stays Unavailable and never falls back to the work folder.
- Task links: direct load, reload, Back and Forward on `/task/:id` for an active task with an area, an Inbox task, a completed task beyond the first Completed page, an archived task, a restorable deleted task and a purged ID. Each lands on its host view (3.3) with the task expanded and focused, and the host view's counts and paging unchanged.
- Paged queries: an agent completes an off-screen task and it appears in an empty Completed list. An agent reopens the only completed task and the list empties. A completion lands across a page boundary with focus below it, and the focused row keeps its screen position. A task edited to match the current search shows "Results changed · Refresh". Refresh restarts paging and keeps focus. "Show more" before refresh never skips or repeats a row.
- An expired token shows the signed-out bar and keeps drafts. `navigator.serviceWorker.getRegistrations()` stays empty after an install.
- Every flow runs under the production headers with a `securitypolicyviolation` listener that fails on any report, as `A7.3.12.m5-01.e2e.strict-csp` does for the shell.
- Live updates: an agent re-sorts the list while a row has focus and the row does not move. A sequence gap triggers a snapshot that keeps scroll, expansion and drafts. Reconnect resumes. A new build ID shows the reload bar.
- Feature flags: each flag off in turn removes its UI and shortcuts and leaves no gaps.
- First run end to end with fake detection, including the registration preview, a managed-source case and Skip.
- Keyboard only: every flow above without a pointer.
- axe-core on every screen in both themes. Visual snapshots of every screen in Sumi and Washi at 1,440 and 1,280 px, and at 390 px for reflow.
- The XSS suite: payloads in titles, summaries, context, notes, source titles and URLs, people and area names. No script runs, no unexpected element appears, and no blocked scheme becomes a link.
- The performance test of 3.25.

**Not in this appendix's tests.** The two-user port-squatting test (another local user binds the port while the service is stopped, then the victim reloads with a persisted token) belongs to the M10 gate that A6 and A7 own, and runs only in CI on throwaway runners. v1's own checks for that threat are A2's (3.26).

**Manual, before each UI milestone closes.** A screen-reader pass with NVDA on Windows and Orca on Ubuntu. A reduced-motion pass. A 200 % zoom pass. Windows high-contrast mode.

**What M0 confirms on real machines** (R17), on Windows and on Linux (Ubuntu 24.04 with the Firefox snap). Lab rows U01 to U07 (A7 3.7) carry these. planning/STATUS.md lists the open sessions.

| # | Check | State |
|---|---|---|
| M0-1 | The UI runs in Firefox on both: token handshake, reload with the stored token, WebSocket, the CSP with its style nonce (a React Aria press applies its style with no CSP report), and `navigator.clipboard.writeText` from `http://127.0.0.1` on a click | The page checks pass in headless Firefox 159 on Linux and in Chrome 157 on Windows. Visible Firefox, reload with the stored token and the clipboard are open |
| M0-2 | Firefox lets the page take `/`, `Ctrl+K`, `Ctrl+Enter` and `Ctrl+Shift+Enter`. Record any shortcut it keeps | Open |
| M0-3 | Bundled fonts render through the service under `default-src 'self'` | Passed in Chrome and headless Firefox. Firefox on Windows is open |
| M0-4 | The 5,000-task performance test in the Linux Firefox snap meets 3.25. If not: lower the virtualisation threshold, trim the compact row, or move grouping into a worker, which first needs a reviewed change to `worker-src 'none'` (3.26) | Met headless with no fallback (3.25). The visible run in the snap is open |
| M0-5 | An `https:` source link opens in a new tab, and `place.reveal` opens GNOME Files and Windows Explorer from a UI click | Open |
| M0-6 | Chromium (Chrome or Edge on Windows, and a Chromium on Linux if one is installed) offers to install the UI from its manifest with no service worker registered. If a browser refuses, record it. v1 still adds no service worker before M10 | Open |

---

## 6. Open items

Items 1 to 5 are decided and may be revisited after the first build.

1. **Font.** Inter. The theme token makes a change one line.
2. **Review on Today.** No Review section. Review tasks reach Today only through a star, a date or the Changes digest. If that is not enough, a Review section goes between This week and Next (one setting).
3. **Monogram tiles.** Monograms on the row tile, and a plain open glyph when only one instance is enabled (3.6).
4. **A separate Ask verb.** None in v1 (3.8). A lighter "change this task" agent that never works in the task's folder would be an A4 run recipe and one more button in the strip.
5. **Next limit.** Three.
6. **Authenticated UI origin (M10 gate).** The mechanism (a per-user HTTPS certificate trusted in the user's browser profiles, or a desktop shell with its own channel) is decided before M10 with A6 and A7. Either way the UI changes only its origin and, possibly, regains an offline shell.
8. **The area colour value.** 3.19 stores a slot from 1 to 8, but A1's `areas.color` is free `TEXT` and no operation checks it. To decide with the area operations: that the column holds the slot as text ("1" to "8"), how an import or an agent sets it, and what the UI shows for an empty or unknown value.
11. **The task of a launch entity.** The feed's `launch` entities, and the places of areas and projects, carry no `task`, because the writer records their changes without one. A launch event that names no task makes the page refetch the receipts of every task it follows (the expanded one and those it launched), which the expanded task's thread uses as it is. Decided with M5.09 (A7 3.12): the service adds `task` to launch entities. Places of areas and projects are not part of a task's place on this machine yet (the launch and the row read the task's own place), so a group's place change refetches nothing; when resolution reaches them (3.2), it touches the effective place of every task in the group, and their rows must travel with it as a task's own place change's do (A1 3.7).
12. **Review count and disjoint counts.** U5 keeps the status views disjoint so counts add up, but the Review count also includes pending proposals (3.10), whose tasks may be counted in Open or Waiting too. To decide with M5.09: count proposals separately from tasks, or count a task with a pending proposal only under Review.
13. **The Waiting view's due column.** 3.5 shows the follow-up day (`planned_for`) there, while 3.6 shows a due date first and a planned day only without one. To decide: which wins on a waiting task that has both, and where the other date shows.
14. **The proposal card's fill.** 3.10 puts the card on `--k-surface`, which is not in the token table of 3.19. Either `surface` joins both themes with its contrast pairs, or the card uses an existing token.
15. **Where the theme choice lives.** The plan names A1's space preference `ui.theme`, but a theme per space would change the colours when a tab switches space. The choice is kept per browser until `pref.set` and the snapshot's preferences exist (3.19). To decide then: a space preference, a machine-level one, or the per-browser choice kept.
