# Appendix A5: UI and UX

> What is left in this document is background for parts that are not built yet. The code and its tests are the source of truth for everything that is built, and `docs/promises-and-limits.md` says what a person can count on. Do not add to this document.

## 3. Specification

### 3.3 App shell and navigation

Built, in `packages/web/src/app/`: the frame (`Shell.tsx`), the sidebar, the space switcher, the top bar's add field, the routes (`router.tsx`, with `src/route.ts` reading what arrives from outside), the landing (`Landing.tsx`), and view membership and counts (`views.ts`). Tests: `A5.3.3.web.route`, `A5.3.3.web.landing`, `A5.3.3.web.views`, `A7.3.12.m5-01.e2e.space-per-tab`, `A7.3.12.m5-01.e2e.task-links` and `A7.3.12.m5-01.e2e.add-once`. The host view of a task link is built (`app/host.ts`, `app/pages.tsx`; tests `A5.3.3.web.task-host`, `A7.3.12.m5-06.e2e.task-links`). Not built yet: Refresh, New space and Open folder in the switcher, the Agents live dot, the replica machine name and `/setup/:step`.

**Frame.** A sidebar and a left-aligned main column, separated by space, not a border. The browser tab's title is "<view> · <space>".

**Sidebar**, top to bottom, with no headings: the space switcher, the views, the areas after a gap, and Settings at the foot.

- **The space switcher.** **Switching changes only this browser tab.** The tab's space lives in its route (`/s/:space/…`), so switching navigates, takes a fresh snapshot of the new space and moves the tab's feed to it. Other tabs keep their space, view, feed and drafts. Drafts are kept per space and task, so they survive a switch and a switch back. Sessions and other bindings stay pinned to their own space. "Make default" and `ttasks space use <space>` are the only ways to set the machine's default space, and the default decides only what a new tab and an unbound CLI call use. The popover also offers "New space" and "Open folder". When a later phase shows a replica of another machine's space (A6), the switcher is the one place that shows that machine's name and, while it is unreachable, one "as of 10:42" time.
- **Views:** Today, Inbox (only when not empty), Open, Waiting, Review, Backlog (only when not empty), Completed, Agents. An empty Inbox or Backlog keeps its slot, so its appearance never moves another item. Counts (U2) are part of the link's accessible name ("Waiting, 2 tasks"). Agents shows a small live dot while a session or run is active, not a number.
- **Areas:** a coloured dot and the name, no counts. An open area lists its projects beneath it. A quiet **Add project** item ends the list (3.29), and a project's name opens its project card (3.29) from a button that shows on hover and focus.

**Top bar** (64 px): the search-or-add field (3.13), a New task button, and at the inline end **Refresh**. Refresh starts the space's refresh routine ("Refresh from sources", D8). While it runs, the icon turns slowly and its tooltip reads "Refreshing · started 08:12". When it finishes, a toast says "Refresh finished · Show changes". The bar has no date, avatar or settings button. The add field sends an add once while its text waits for the feed's confirmation (3.15 item 4).

**Status bar.** A one-line bar under the top bar, only for service problems (3.16).

**Routes.** Every screen has a URL, so reload, Back and Forward work and agents can print links. Every parameter comes from the URL, so each is checked by its shape before use, and a path of another shape lands on `/`. `/` opens the machine's default space when the service serves it, else the one served space; otherwise the person picks, and a default that is set but not served is never replaced by another space. `ttasks open` puts the route the tab should open in the URL fragment next to the one-time code; the page removes the fragment before any request. `tasks://` links (A6) map to the task route and only navigate. Still to add: `/setup/:step` (3.17). **The service answers with the page only for paths of `APP_ROUTE`'s shape** (`packages/service/src/http/checks.ts`: `/`, `/index.html`, and `/s/<space>` plus at most four plain segments). A route outside that shape, such as `/setup/:step`, widens that rule in the same change, or reloading it fails.

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

### 3.7 The expanded task

Built, in `packages/web/src/task/`: `Expanded.tsx` (the body and the facts), `Thread.tsx`, `detail.ts` and `useDetail.ts` (the detail read and its refetch), `markdown.tsx` (3.26), and the header in `row/Row.tsx`. Tests: `A5.3.7.web.detail`, `A5.3.15.web.expanded-state`, `A5.3.26.web.markdown`, `A7.3.12.m5-06.e2e.expanded`, `A7.3.12.m5-06.e2e.keyboard`, `A7.3.12.m5-06.e2e.screens`. The facts are edited in place (`Facts.tsx`, `DuePicker.tsx`, `AreaPicker.tsx`; 3.11), and the composer's field holds its draft (`Composer.tsx`, `composer.ts`; 3.8). Still to build: the proposal card (M5.09), the folder's Change, Choose folder and Clear (they need the folder browser, 3.29, M5.14), the composer's strip (M5.07; until then a button per instance and Copy sit under the field), Open folder (with `folder.reveal`), related learnings (A3's learning search), runs (M6) and grouped field changes with Revert (M5.09).

**The detail.** The live row holds the header's and the facts' data. The rest comes from `task.get` in two reads that start together: the digest for the task's own facts in any lifecycle (its folder on this machine, when it was created), and the sections (instructions, context, notes, log, sources, outcome) read page after page, at most 20 pages, joining a text a page boundary split. The detail is read again whenever a frame of the feed touches the task (3.15 item 8), and after a fresh snapshot, which names only the working set's tasks and so not a completed one. A read that fails keeps what is shown and says it may be out of date.

The row becomes a card on `--k-raised` (radius 12) in place. The mockup shows the layout.

**Header.** Checkbox, title, summary under it (wrapped, not truncated), and at the inline end the star and a collapse button, which takes the launch tile's column. The due, age, priority, source and folder slots fade out, and the status chip and the area and project prefix go, because the body now owns those facts. The title edits in place with `F2` or a double-click, for typo fixes: Enter or leaving the field saves it as a person's edit (3.11), with the cursor the editor opened at as its base, so a title someone changed while the person typed is a conflict and is never overwritten: the field says "Changed by Codex just now" while the person types, and after the save the header keeps their title under the current one with Apply mine. Leaving the window is not leaving the field. Escape keeps the old title, and focus returns to the title. The collapse button puts focus on the title before the card closes, as Escape does. Only an open task's title edits, the one kind the service changes.

**Body.** Two columns: content `1fr` and facts 252 px, with a 40 px gap. The content aligns with the title.

**Left column, top to bottom, with no section labels:**

1. **Proposal card**, when one is pending (3.10). Full width.
   - **Outcome**, once the task is completed: the outcome as Markdown with the outcome icon. The task's own learnings follow among the links, with the learning icon, before any related ones.
2. **Context**: the agent-maintained understanding, as Markdown (3.26) in `--k-text-2`. Over 10 lines it clamps with a "More" button.
3. **Links**: one line each, icon first.
   - Sources show their own text: "Wrong appointment times since Sunday · Ana Reyes" (mail), "LUM-212 Appointments off by one hour" (ticket, key in mono), "#lumen-dev · Jonas Berg" (chat). No "Email" label and no domain. The domain and URL are in the tooltip. A source whose own text is the task's title or summary (a task named after its email), read without case, spacing or a closing full stop, shows its key instead, or its kind's name ("Document") when it has none, so the card shows the string once.
   - The folder, the one Open and Run use (A1 3.15): `~/work/lumen/portal` in mono, with Open folder, Copy path and Change. When it is the project's, a muted "· project" follows the path, and Change gives the task a folder of its own. When it is the task's own, Clear removes it, and the task then uses its project's folder or the TTasks work folder. The machine is in the tooltip. A missing folder shows the path muted, "Not found on this computer", and Choose folder. A folder on another machine shows "On mira-laptop · ~/work/lumen/portal" and "Add folder on this computer". A task that uses the work folder shows "TTasks work folder" in muted text, with Open folder and Copy path once it exists, and Choose folder to give the task a folder of its own. Change and Choose folder open the folder browser (3.29).
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
| **Run** | `Ctrl+Shift+Enter` in the composer, `Shift+R` on a row | Starts a background run in the task's folder (or the TTasks work folder) with the text as the request. Progress and the reply land in the thread. A run never completes the task (R9). v1 runs only through the CLI adapters (A4), so Run uses the effective instance when it is a Claude Code or Codex instance, and otherwise the first pinned instance that can run. The button's name says which ("Run in the background with Codex · work"). With none, Run is disabled with "No instance here can run in the background" |
| **Copy** | Click. `Shift`+click copies the context pack | Copies the pointer brief with the text (`launch.open` without an instance, 3.28), or the context pack for apps without the TTasks tools (A4). Toast: "Copied" or "Context pack copied" |

**Asking an agent** is Open with text (interactive, in the agent app) or Run with text (in the background, reply in the thread). A4 has no Ask mode, so the strip has no third verb (open item 4). Clicking an agent-only field (3.11) starts such a request in the field.

Rules:

- **Instances shown.** The space's pinned instances (A4 space references), default first, in their saved order. If they do not fit on one line, the strip wraps. There is never an overflow menu. A pinned instance that does not exist on this machine shows "Not set up on this machine" and stays disabled.
- **Empty field.** Note is disabled. Open sends the brief alone. Run focuses the field with the placeholder "What should the agent do?" and waits.
- **Text after an action.** Note, and a launch or run that reaches Dispatched or `queued`, clear the field. If a launch fails or becomes Unknown, its text goes back into the field.
- **Questions before dispatch.** While a launch is Prepared, A4 may need an answer: the account check ("This task is in Work. Codex · personal is for personal work. Open anyway?"), "Register in T3?", a pre-trust step, or the permission mode for an `inherit` instance's first Run. Each appears as one inline line in place of the strip's buttons, with the exact subject and two buttons. There is no dialog. T3's question reads "Register <name> as a T3 project?" with Register and Not now. Not now is kept per folder for 30 days, and meanwhile T3 is Unavailable there with "T3 opens only registered folders". Declining closes the Prepared intent. Until the service offers a cancel, its sweep expires it.
- **First Run per instance and machine.** The same inline line: "Codex · work runs with full access in ~/work/lumen/portal · Run · Cancel". After one confirmation it never shows again, unless the instance's permission mode changes.
- **No folder.** For a task with no folder of its own or its project's anywhere, Open and Run work in the space's **TTasks work folder** (3.2, A4), never another folder (R11). Each route asks its usual questions there, and the inline questions and the first-Run confirmation name it ("Codex · work runs with full access in TTasks work folder · Run · Cancel"), so the user sees where the agent works. A task _with_ a folder always uses exactly that folder, and a missing folder stays Unavailable rather than falling back to the project's folder or the work folder. Copy stays available.
- **Disabled buttons** stay visible and focusable at reduced opacity, with the reason in the tooltip: "Folder not found on this computer", "Not set up on this machine", "No graphical session", "Opens on mira-desktop".
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
| Unknown | "TTasks lost track of this launch. It may have opened." in ochre | Check, Open again (a new intent), Copy. Nothing happens without a click |

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

Stop asks once inline ("Stop run? · Stop"). Continue interactively on a running run first asks "Stop the run and continue in a terminal?" (A4). A run whose MCP server did not connect says "without the TTasks tools" in its entry. Routines show the same states in the Agents view and on the Refresh button.

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
- **Revert plans**: Revert all for a session or run first fetches A1's `dry_run` plan, shows the fields it restores and any conflicts, then applies on confirmation. One line under the plan reads "Reverting cannot recall what the agent did outside TTasks, such as sent email or pushed commits".
- **Setup changes** (3.17), with a file path in place of the field label.

### 3.11 Field editing

Built, in `packages/web/src/edit/` (`edits.ts`, `calls.ts`, `change.ts`, `due.ts`, `Unsaved.tsx`) and the facts in `src/task/` (3.7). Tests: `A5.3.11.web.edits`, `A5.3.11.web.edit-queue`, `A5.3.11.web.due`, `A7.3.12.m5-08.e2e.flow`, `A7.3.12.m5-08.e2e.conflict`, `A7.3.12.m5-08.e2e.ask`, `A7.3.12.m5-08.e2e.screens`. By hand today: done, star, priority, effort, due, status, waiting on, Move to Open, area and project, and the title. Not yet: Drop (the service refuses `dropped` until M3.04), waiting on's expected date (`task.update` has no `planned_for`), the folder (it needs the folder browser, 3.29), moving a task out of every area (`task.update` moves into an area or project only), and the row keys, which come with `ui.keys.single` (M5.11). The statuses and the effort scale are the defaults until the snapshot carries `tasks.statuses` and `tasks.effort_scale`; a task's own value outside them is shown as one more option.
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
| Folder | Yes | The folder browser (3.29). Clearing it removes the task's own folder on this machine: the task then uses its project's folder, or the TTasks work folder when the project has none | — |
| Title | Yes, for typos | Inline edit | `F2` while expanded |
| Summary, context, sources, outcome, learnings | No | Click-to-ask | — |
| Notes | Own notes | Composer, Edit on the entry | `m` focuses the composer |

**The date popover.** A text field with a live preview ("Friday 20 November"), five quick picks (Today, Tomorrow, Next Monday, In a week, None) and a month grid with one tab stop (the arrows move a day or a week, Page Up and Page Down a month, Home and End to the week's ends). The text field reads an ISO date, `tod` and `today`, `tom` and `tomorrow`, weekday names (today on that day, as the service reads them), `+3d`, `+2w` and `-` to clear, and the page sends the calendar date it read, so the preview is exactly what is saved. chrono-node's phrases are not read: they would add a dependency for what the picks and the grid already cover. The grid is the page's own, not React Aria's Calendar, whose calendar systems would cost the bundle more than the grid. Unparseable text shows "Not a date" and Enter does nothing. A past date shows "in the past" in the preview. `Enter` applies and `Esc` cancels. Focus returns to the pill. A due time is shown, and an edit replaces it with a date: the service sets dates only.

**Click-to-ask.** Clicking an agent-only field (not a link or button inside it, and not the end of a text selection) focuses the composer with a stub such as "Change the summary: ", after whatever the person had written there, which stays. Its tooltip reads "Ask an agent to change this". It works for every task: a task without a folder sends the request through Open or Run in the TTasks work folder (3.8). Built for the context, the outcome, a source's line, a learning and the expanded header's summary: `askFor` in `src/task/composer.ts` is the one entry point, and the composer's field listens for it. The keyboard's way to the same request is the composer itself.

**Writes.** Every hand edit takes one path, `Edits.edit` (`edit/edits.ts`), whatever control made it: the star, the title, a fact, Apply mine and Restore mine. It sends one `task.update` with a request ID and `base` through the live store, so the control shows the new value at once as an overlay (3.15 item 4), and a toast names it with Undo (3.12). No pending state is drawn: the overlay is the answer, and a refusal says so.
- **The base.** A control's edit takes the applied cursor when the person acts: what the rows on screen show. An editor that stays open while the person types or reads (the title, who it waits on, the date popover) takes it when it opens, so a change someone made meanwhile is a conflict, never overwritten. Edits of one task go out one after another, each after the outcome of the one before. A base moves past what the person saw in two ways only, and takes the later: over the tab's own commits that directly follow it (sequence numbers one after another, edits, check-offs, undo and redo alike), because then nobody else committed in between; and to the tab's own newest write of every field the edit writes, when one commit wrote them all, because that write passed its own base check, so nobody else wrote those fields in between. So two quick edits of one field never conflict with each other, Move to Open right after choosing a status does not conflict with that status, and an edit right after the person's own undo moves past it, while an agent's change to another field between them still conflicts. An answer's `as_of` alone never moves a base: it covers every commit before it, including ones the person has not seen. A limit of the rule: when someone else's commit falls between what the person saw and the person's own edit of only some of the fields, the next edit of several fields keeps what the person saw and meets the person's own change as a conflict, which Apply mine resolves; proving the other fields untouched would need the feed.
- **A newer choice wins, field by field.** A change of several fields (Move to Open, Restore mine) is kept as its one-field parts. A refusal keeps every part whose field the person has not edited again since, and drops the others with no toast: the newer edit stands. A newer edit of one field drops only that field's waiting value.
- **Ctrl+Z, Redo and a toast's Undo keep the order the person acted in.** They wait for the person's edits on their way, so the undo takes back the newest of them, never one before it while the newest is still to be sent. An edit made after them waits for them in turn (it shows at once), so an unnamed undo never takes back a change the person made after pressing it. Each takes its place when the person acts: a toast's Undo whose commit is not known yet finds it in its place (3.12), so an edit made after the click goes out after the undo.
- **No request holds the queue** (`edit/calls.ts`). The queue waits for each request's outcome: the service's answer, a refusal it decided, or the request's receipt (A1 3.8). A request with no answer after 5 s, or one that failed on the way (no reply, or `service_unavailable` or `space_unavailable`: busy, a timeout, a space that is opening), has an unknown outcome: it may still be in the service's queue and apply later. The page then asks `receipt.get` by the request's own ID, which the service answers from a reader even while its writer is busy, and sends the request again with the same ID and input, which the writer applies at most once and otherwise replays (A1 3.8). The first decision of any of them is the outcome, and the queue goes on with the base it gives (an undo's commit is the tab's own, so the next edit's base moves past it). The deadline is about when a person notices that nothing happened, not a guess about the machine: asking never treats the request as lost, and an answer that comes after it is still taken. With no decision 5 s later (the service is down, or hangs), the outcome cannot be learned now. The request keeps its place, and whatever waits behind it is not sent: each waiting edit loses its overlay and is kept as "Not saved" with Try again, as after a failed call, and a waiting undo or redo says it was not done. Nothing is sent in an order that could make an unnamed undo take back the wrong change. The next request behind it asks again first, so Try again goes out once the outcome is known. A decision that comes later, an answer or the feed naming the request, is still taken.
- **An outcome is decided once** (`Call` in `edit/calls.ts`, `Edits` `#outcome` in `edit/edits.ts`). The first decision of a request, from its answer, its replay or its receipt, is its outcome, and everything that depends on it runs from that decision, once: the bookkeeping the next edit's base reads, before anything waiting on the request goes on, and the line under the field and the toast. An answer or receipt of the same request that arrives after it changes nothing, because a replayed answer carries the original `as_of` and reading it again would move a base back past the tab's own newer write. The one thing shown before a decision is the interim outcome when no answer came, which says "Not saved". A decision that comes after it is reconciled against what the page showed. A success takes the "Not saved" line away. A refusal shows what was decided: a conflict names who changed the field and offers Apply mine, and a finished or deleted task offers no Try again. Either applies only to a value the person has not edited, applied or discarded since, and its toast replaces the interim one only while that is still shown. A late success of an undo, a redo or a check-off says so with its Redo or Undo, on the same terms. The edits do not learn when a toast closes or a plain message takes its place, so a late toast can also follow an interim one the person closed. That costs one toast and loses nothing. A receipt keeps a conflict without its values and an undo's receipt names no tasks, so an outcome learned from a receipt offers no Restore mine, and a row in its hold waits for the feed to come back. Once the tab stops (closed, signed out), nothing more is asked.
- **An editor that saves on leaving saves when it goes away.** The title and who it waits on save a changed value when the row or card they are in goes away under them (the view changes, the card collapses). Who it waits on stays shown while the person edits it, even when someone else moves the task out of Waiting meanwhile. A finished task (completed, or dropped and archived) still shows each value the person chose that was not saved, as text under "Not saved: the task is finished" with Copy and Discard, so a check-off by someone else never hides it: its read-only facts show the facts' values, and the line under the title shows the typed title. A finished task takes no edit (`TASK_NOT_ACTIVE`), nor a deleted one (`DELETED`), so neither the line nor the refusal's toast offers a Try again that would only fail again; reopened or restored, the task's control offers Try again. A deleted task is not on screen, so its values wait unseen until it is restored. The star's toggle has no line of its own: its refusal's toast is all that shows it. Enter and Escape in the title put focus back on the title; leaving it for another control keeps focus there.
- **A refusal keeps the person's value.** On a conflict the control shows the current value, and the line under it says "Changed by Codex just now" with Apply mine (the person's value again, with a fresh base) and Keep theirs. A failed call shows "Not saved" with Try again and Discard. A toast says the same with the one action, for a control that is not on screen. The value waits per task and field in the tab's edits until the person chooses, through feed updates, fresh snapshots and a collapsed card. A reload loses it: it is the tab's, not the space's.
- **While an editor is open,** a change by someone else to its field shows under it ("Changed by Codex just now") and the typed text stays (3.15 item 9). Leaving the window, for another app or tab, does not end the editor.

**Settings and preferences** are operations too, so they are undoable.

### 3.14 Agent changes: the marker and the digest

**The changed marker.** A task shows the 6 px accent dot when an operation by any actor other than the user (agent session, run, routine, import, another machine) has a sequence number above the task's `seen` cursor. The prototype import is the exception: its tasks start as seen and get no dot (A7 3.15.3). The tooltip names the latest change: "Codex moved this to Review · 10:42", or "Codex changed 3 fields · 10:42". Expanding the task advances its `seen` cursor and clears the dot. Tasks the user creates start as seen. The dot is derived from history, so it appears at every autonomy level, including Full. A3's "mark" at Review is this same dot.

**The digest** is the Changes section on Today. It lists agent changes after the space's `digest` cursor, for tasks not shown elsewhere on Today, plus agent completions and agent-created tasks. Each line: the actor's monogram, one sentence with the task title as a link, and the time. Changes to one task collapse into one line ("Codex changed due and priority on _Book the moving van_"). Lines older than seven days drop off. At most five lines show. When there are more, the last line reads "More in Agents". Activating a title expands the task in place with its thread scrolled to the first new entry. Each line has Revert on hover and focus. The heading has one Clear button, which advances the digest cursor. The section hides until new changes arrive.

The **Agents** view is the full history: every session, run, routine and import, each expandable to its changes, with Revert per line and Revert all.

**Where the cursors live.** Both are UI conveniences, not space data. The service keeps them in machine-local UI state in A2's state folder (`ui-state.sqlite`: task ID → seen `(epoch, incarnation, seq)`, plus one digest cursor per space), outside history and undo. One machine owns each space (D16), so per-machine state is enough in v1. Losing the file only shows the dots again. A cursor from another epoch or incarnation counts as unknown in the same way, never compared by `seq` alone. Two small UI-only calls write them, `ui.mark_seen` and `ui.clear_digest` (A3 3.2.3), which never enter the operation log.

### 3.17 First-run setup

A centred column (max 560 px) outside the normal frame, at `/setup/:step`. Each step has a small title, its content, and Back, Skip and Continue. Progress is a row of dots, labelled "Step 2 of 7" for screen readers. Steps 0 and 1 are required. Every later step can be skipped and is reachable again from Settings.

| Step | Content |
|---|---|
| 0. Before you start | A6's "use at your own risk" paragraph and Continue. Shown once, never as a recurring banner |
| 1. Space | Name the space ("Work", "Personal"). Location `~/.ttasks/spaces/<slug>` (`%USERPROFILE%\.ttasks\spaces\<slug>` on Windows), editable. Or "Open a space folder". Or "Try the sample space", a separate folder built from the fixture, never mixed into a real space. The step names the data folder `~/.ttasks`, because it is hidden. The machine name is prefilled from the hostname |
| 2. Autonomy | Three choices: **Full**, **Review** (preselected, A3) and **Suggest**. One line of help each on hover and focus: "Agents change and complete tasks directly", "Agents change tasks with a mark. Completions wait for you", "Agents only propose". A6's risk text sits next to Full. Plus a switch: "Agent-created tasks go to Inbox" (off for Full and Review, on for Suggest) |
| 3. Agent apps | The instances A4 detected ("Found a second Codex home, `~/.codex-alt`. Add it?"), each with a checkbox, an editable label naming the account, its monogram and ring, the version found, its config home in mono and its permission mode. A6's risk text appears once when any selected instance uses full access. A radio button picks the default instance. Two instances with the same monogram and ring are refused with a suggested ring. Nothing is added without a tick. From the command line: `ttasks setup instances` (A4 3.2) |
| 4. Connect | For each selected instance, the **MCP registration preview** of `ttasks setup agents` (A3 3.13.1): the file as a header, the exact command the app's own `mcp add` runs, and the key-level diff in mono. The optional instruction block for `AGENTS.md` or `CLAUDE.md` is a separate, unchecked item with its own diff (D15). For a managed instruction source, the step shows the text with a Copy button instead of a diff. Apply runs the same setup engine as the CLI, in the service once it has A4 3.8's agent environment, because the apps' commands must be the ones on the person's PATH. It is bound to the preview it shows by the preview's plan token, so it refuses and changes nothing when a home changed since. It lists what changed. Nothing touches another app's trust settings (R16). A home setup refuses (a file or folder that is a link, that another user owns or that every user can write, a managed or unreadable file, an entry of the product's name it did not write) shows why in place of a diff. When Claude Desktop has several configuration files, the step asks which one the app uses, as the CLI's `--home` names it (A3 3.13.3). Each instance then shows a check result from `ttasks doctor` (configured, or the reason it is not) |
| 5. Projects | Add project (3.29) as often as the person likes, then Continue, or Skip. Nothing is detected or added without the person's choice, and a space works without any project |
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
| Folders | Machine name. Every project's folder on this machine and elsewhere, each with its project card (3.29). **Use the same folders here** when folders of other machines have no folder here (A1 3.15): it lists each such project or task with a checkbox and the path that exists on this computer, or a choice of paths when several machines' paths exist here (one at most per owner), and binds the chosen ones in one commit (`folder.adopt`), one undo step. This space's TTasks work folder on this machine (path read-only, with Open folder) |
| Keyboard | Single-key shortcuts (on, off, require Alt), remapping, the shortcut sheet |
| Data | Markdown projection, export, import with preview, backups, and Trash (deleted tasks with Restore), all from A1 |
| About | Version, the data folder, the `ttasks doctor` summary, licences |

Built so far: the one section `appearance`, which holds the theme (3.19). The sections above replace it, and the theme moves to General.

Autonomy, instances, routines and connections are policy. Agents cannot change them (R7). Their pages carry a small lock glyph with the tooltip "Only you can change this".

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

### 3.25 Performance

Targets hold on a real Ubuntu 24.04 machine, in the Firefox snap, with a seeded space at A1's **design scale**: **5,000 open tasks** and 50,000 completed, 30 areas and 200 projects, with 10 agent sessions writing and the service already running. A1 owns these numbers. Its larger stress corpus is for A1 and A3's query budgets, not for these targets.

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

**Still to build:** the Playwright performance test over this table, in CI (Chromium and Firefox on Linux) and on a real Ubuntu 24.04 machine at each UI milestone.

**Measured so far** (M0 lab row U07, 5,000 rows, headless Firefox 159): 60 fps scrolling, view switch p95 23 to 24 ms, burst script work 12 to 15 ms with no late frame. The stack needs none of M0-4's fallbacks. The burst has little margin, and the spike re-derived all 5,000 tasks per burst where the product derives per event. The visible run in the Firefox snap is still open (M0-4); a miss there reopens the stack choice before M5.13. Headless Firefox keeps a 1366 × 768 window and reports `performance.now()` in whole milliseconds, so headless numbers are coarse.

### 3.29 Add project, the folder browser and the project card

Not built yet (M5.14). A project's folder is chosen where the person adds the project, in a flow like T3 Code's Add project: pick the device, pick the source, browse to the folder (D28, A1 3.15). An agent does the same through `organize` (A3 3.4.10).

**Add project** opens from the sidebar's Add project item, from first-run step 5 and from Settings › Folders, as a centred panel over the view (max 560 px) with one field on top and a list below, keyboard-first. `Esc` steps back, and from the first step closes it. Each step's title is small and the panel has no other text.

1. **Device.** Skipped while this computer is the only machine the space knows. Otherwise this computer comes first and is chosen; every other machine of the space's `machines` is listed and disabled, with the one line "Add it on that computer": only a machine's own service can look at its folders.
2. **Source.** Local folder, New folder, No folder. Clone a repository and Start a new Git repository are later additions to this list.
3. **The folder browser** (Local folder and New folder). A path field over the list of folders there, starting at `~` or, when the current view is an area whose projects share a parent folder, at that folder.
   - The field shows the path with the home as `~` and accepts any absolute path or `~` path. Typing filters the list by name, Tab completes the one match, Enter on a row goes into it, and `..` (the first row) goes up. On Windows, above a drive's root the list shows the drives.
   - Each row is a folder's name. A link shows a link mark and is followed only when the person opens it. A hidden folder (a name that starts with a dot) is muted. A folder that is already a project's shows that project's name.
   - **Add** (Enter with the field's text, or the button at the field's end) takes the folder in the field. A folder that is already a live project's opens that project's card instead. Missing, unreadable and timed-out folders show one line in place of the list ("Not found", "Can't be read", "Did not answer"), and Add stays disabled.
   - A **Reveal** button opens the folder in the system's file manager (`folder.reveal`).
   - **New folder** shows a second field for the new folder's name under the path; Create makes it (`folder.make`) inside the folder in the field, then goes on to step 4 with it.
4. **Name and area.** The name is prefilled from the folder's last name, the area from the current view (none in Today and the status views). Create sends one request that creates the project with its folder (A1 3.6), one undo step, and the toast says "Added Lumen portal · Undo". No folder skips step 3 and creates the project alone.

**The service calls behind it**, for the person's page only, never agent tools: agents have their own file tools (A3 3.2.3).
- `folder.browse {path}` (UI-only) lists one directory of this machine: `{path, state, entries[], more}`. `path` is the stored form (A1 3.15) of the folder listed. `state` is `ok`, `missing`, `not_a_directory`, `unreadable` or `timed_out`. Each entry has `name`, and `link: true` or `hidden: true` where it applies. Folders only, and links of any kind not followed, so the call reads no file names, sizes or contents. At most 2,000 entries, sorted by name, with `more` when there were others. The listing goes through A1 3.15's bounded look: a listing that has not answered within 2 s answers `timed_out`, so a hung network share never hangs the page, and a hung call holds only a worker of the folder module, never the service's own file system threads. At most two listings run at once. A listing that timed out leaves its slot at once, and one still waiting for a slot after its 2 s answers `timed_out` too. A share that never answers costs at most two waiting workers (A1 3.15's per-location bound), answers `timed_out` at once after that, and never blocks a listing of a folder in another location. On Windows, `path` empty lists the drives.
- `folder.make {parent, name}` (user-only) creates one new folder through `packages/files`, refusing a name that exists, is not one valid name on this OS, or a parent that is missing. It writes no operation: the binding that follows is the operation.
- `folder.reveal {path}` (UI-only) opens the folder in the file manager.

**The project card** opens from the project's name in the sidebar and from Add project when the folder is already a project's. It holds the project's name and area (editable as facts are, 3.11) and its folders, one line per machine: this computer first, "This computer · ~/work/lumen/portal" with **Change**, **Open folder** and **Remove**, then each other machine, "mira-laptop · ~/work/lumen/portal", read-only. A project with no folder here shows **Add folder on this computer**. Change opens the folder browser at the current folder, and moves the task folders inside it with it (A1 3.15). Remove asks nothing and shows the toast with Undo. A folder on this computer that is on disk the same folder as another live project's (only an undo or a restore across two spellings leaves one, A1 3.15) shows "Same folder as <project>" under its line. Archive (Unarchive on an archived project) and Delete sit at the card's foot, as for a task (3.12).

**The expanded task's folder** is 3.7's: its own or its project's, with Change, Choose folder and Clear.
---
