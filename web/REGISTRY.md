# Where the web UI's components come from

shadcn/ui first (DESIGN.md, Components). Each file in `src/components` is either the registry's,
changed only where the app needs it, or ours for a stated reason. Checked against the registry on
2026-10-15, after shadcn's
[October 2026 changelog](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements) (Trace, Code
Block, AI Elements as patterns).

## How they come in

- **Style.** `components.json` names **radix-vega**, the radix-* style closest to new-york-v4 (the
  one Trace and Code Block came from). Every `ui/*` file was pulled again with
  `shadcn add <items> --overwrite` and its diff reviewed, then our changes below put back.
- **CLI.** `shadcn` is pinned exactly in `package.json` (4.21.5). A plain `add` now works: the
  style and its dependencies resolve, and `cn` is already installed. One edit follows every add:
  the radix-* sources import `cn` from the npm package, and ours import it from `@/lib/utils`
  instead, which carries the theme (below). Then `bun run lint` (never `--fix`): the
  better-tailwindcss canonical-class rule catches what would change a merge (`text-sm
  leading-relaxed` keeps its line height when a caller passes `text-read`; `text-sm/relaxed` gives
  way).
- **cn.** shadcn's [`cn`](https://github.com/shadcn-ui/cn) package, 0.4.0 exact, in place of clsx
  and tailwind-merge (same output: a differential run over the 549 class strings in `src`, every
  pair merged both ways, differed only in the order of two repeated unknown classes). It is
  extended the way tailwind-merge was: `cn.config.mjs` names the theme's text sizes (text-2xs,
  text-ui, text-read), the glass radius (`rounded-glass`, which the sheets' and the composer's
  corners need to win over the Drawer's) and the shadows and hairlines that replace one another, and `bun run
  cn-tables` compiles that with every class group into `src/lib/cn-tables.ts` (`cn build --full`),
  which `src/lib/utils.ts` hands to `cn/engine`. Compiled ahead because `cn/config`'s `createCn`
  compiles at run time and would add 12.6 kB gzipped to the startup bundle; `--full` so the tables
  never depend on which classes the sources happen to use. `utils.test.ts` fails when the tables
  are stale, and another when index.css's @theme adds a text size or radius the config lacks.
  `cn build` can read `@theme` from a stylesheet, but 0.4.0 takes the `/*` in
  `@source "…/dist/*.js"` for a comment and misses our @theme block, so the config names them.
  Streamdown imports `twMerge` from tailwind-merge and class-variance-authority imports `clsx`, so
  Vite aliases `tailwind-merge` to `src/lib/tw-compat.ts`, tailwind-merge's API on our one engine
  and tables (`utils.ts` builds `cn` on the same engine), and `clsx` to `cn/engine`. Aliasing
  tailwind-merge to `cn` itself, as cn's docs suggest, would ship `cn`'s default tables as a second
  set, and Streamdown's merges wouldn't know the theme's classes. The old packages are out of the
  bundle; Tailwind skips the tables file.
- **vaul.** 1.1.2, exact, for shadcn's Drawer. It is vaul's last release (December 2024), and its
  README says the project is unmaintained. It is kept by choice: check it on devices (TODO.md).

## Component by component

Every `ui/*` file below imports `cn` from `@/lib/utils` (see CLI); that is not repeated per row.

| Component | Source | Ours differs | Why |
| --- | --- | --- | --- |
| ui/button | radix-vega | `icon-sm` is 40 px on touch (`pointer-coarse:size-10`) | 40 px touch targets |
| ui/input-group | radix-vega | `icon-sm` 40 px on touch; `icon-md` (36/40 px, round, no border); `instanceof Element` for the registry's `as HTMLElement` | Touch targets; the composer's send and stop (radix-vega's Button has a transparent border and clips its fill inside it, which would draw them at 34 px); lint |
| ui/bubble | radix-vega | a `soft` variant | The user's bubble |
| ui/progress | radix-vega | `?? 0` for `\|\| 0` | Lint |
| ui/tabs | radix-vega | inactive text is muted-foreground, not foreground/60 | AA |
| ui/message-scroller | radix-vega over @shadcn/react 0.3.1 | re-exports the package's hooks in one `export … from` | Lint |
| ui/trace | radix-vega | lint-only edits | — |
| ui/code-block, hooks/use-highlighted-code, lib/highlighter | radix-vega | themes; lazy load; lint-only edits | GitHub's high-contrast pair (the default's #e36209 reads 3.5:1). shiki loads on first use, out of the startup bundle |
| ui/drawer | radix-vega (vaul) | the grabber in `bg-soft-strong`; the overlay stays black at 50% (new-york's), not radix-vega's 10% with a blur | The grabber shows on glass. The sheets' glass (92%) was measured AA over the page as a 50% overlay dims it. The app's one sheet, dressed in `components/sheet-drawer.tsx` |
| ui/tooltip | radix-vega | lint-only edit | One provider at the app root |
| ui/badge, collapsible, input, textarea, marker, message, popover | radix-vega | — | — |
| ui/chart | new-york-v4, cut down | only what Stats uses | radix-vega's chart is the same for the parts we keep (container, tooltip, legend); its full file adds the payload guessing Stats doesn't need |
| ui/segmented | ours | — | shadcn has no segmented control |
| ai-elements/tool | the Tool pattern on Trace and Code Block | Failed from the logged flag only | SPEC E28 |
| ai-elements/queue | the Queue pattern on Trace | items wrap; take-back beside them | A held message shows text, thumbnails and its engine |
| ai-elements/message | the Message pattern (MessageFooter, Tooltip) | the footer's slot is `message-actions`; Streamdown hardened | Tap-to-reveal finds the row by it. No remote images; no downloads in the iOS app |
| ai-elements/shimmer | shadcn's `shimmer` utility | rests muted, sweeps to ink; plain text without color-mix | AA throughout. Old Safari |
| ai-elements/context | ours | a Popover, not the pattern's Hover Card | A phone can't hover |
| ai-elements/prompt-input | ours on Input Group, its tiles on ui/attachment's `tile` size | progress bar, HD toggle | Glass composer, held tray, iOS file inputs inside the tap, drafts. Attachment has states but no progress |
| ui/attachment | radix-vega | a `tile` size (ours): the media alone, 64 px, no card; for the composer's tray | The tray's thumbnails. A failed tile takes the registry's error look (a red tint, the icon in red) under our red ring. A message's thumbnails are plain links: nothing for Attachment to carry, and its image media crops square |
| ui/dropdown-menu | radix-vega | — | The Model Selector. A disabled item's 50% opacity is set back at the call site (muted text instead, AA) |
| ai-elements/plan | the Plan pattern on Trace | a turn's last TodoWrite is its plan, the earlier calls plain tool lines; live only in the run that goes on now (from RUN_STARTED), and there only its newest plan; pending steps not dimmed; the call as logged behind one line; the newest plan open until the reader chooses | One list per turn, not "0 of 3" above "3 of 3"; one live list per run, though a steered message starts a turn of its own. AA (Trace's `pending` is 60% opacity). SPEC: rendering never hides what the model wrote |
| ai-elements/reasoning | the Reasoning pattern on Trace | collapsed by default, also while it streams (the pattern opens itself then); plain text, not markdown; open state per piece in the session store, for this page only, carried when a steer moves it; its text read from the server when first opened after a reload (a failed read retried on reopening, a missing one said); what the caps cut said under it | A phone has no room for a long think pushing the reply down; SPEC: rendering never hides what the model wrote, and a 1,500-row history loads no thinking it doesn't open. Its shimmer is Trace's running status, as a running tool's |
| ai-elements/sources | the Sources pattern on Trace | collapsed by default; the host beside a title; a turn ends at a user row | Tool lines are collapsed too; a title alone doesn't say where a link goes. The log keeps no turn boundaries, so a steered message (and later a subagent's report) starts the next turn's sources |
| ai-elements/subagent | the Subagent pattern on Trace, Badge and our Tool | Tell is a line inside it, also on one that has ended (it starts it again); a `model` slot holds the card's Model Selector in place of the engine badge | SPEC M7a wires it (chat/subagents.tsx) into Background work's `extra` slot, one card per subagent the state lists. A button can't sit in a trigger, so Stop is beside the line (the pattern's PlanAction) |
| chat/pickers ModelSelector | the Model Selector pattern on Dropdown Menu | one menu, no effort menu; touch keeps the native select; grouped by `engineParts(ref).where` (src/wire.ts) | An effort is part of a chain entry, not a free choice; SPEC wants the phone's own picker |

### What the radix-vega switch changes on screen

Taken before and after at 390 and 1280 px, light and dark (chat, an open tool, the tray, the
follow-ups popover, Background work, Add context, the held banner, a failed tool, Memory, Stats,
Devices), and diffed pixel by pixel. Everything not listed here came out identical (Memory, Stats
and Devices differ only in their timestamps, data and temp paths).

- **Sheets** (Background work, Add context): the grabber is 6 px tall, not 8 (radix-vega's).
  radix-vega's overlay (black at 10% with a slight blur) is not taken: the sheets' glass was
  measured AA over the 50% overlay, so ui/drawer keeps that.
  radix-vega rounds a side panel's leading corners (14 px); `sheet-drawer.tsx` keeps Background
  work's side panel square, as it was.
- **Small buttons** (the held banner's "Try … again" and "Continue with …", Devices' "Background
  work", Memory's back): 10 px side padding instead of 12, a 1 px press-down, and hover fills from
  `muted` instead of `accent` (the same colour in our theme).
- **Popovers** keep their look: the registry's `ring-1`, `gap-4` and `text-sm` are set back at the
  call sites (`ring-0` under `shadow-float`, which has its own ring; the follow-ups popover's
  `space-y-3` became `gap-3`).
- **A failed upload's tile** takes Attachment's error look: a red tint and the icon in red, inside
  the red ring it had.
- **The sheet's title** keeps 600 weight (radix-vega's is 500) in `sheet-drawer.tsx`.

## The October 2026 patterns, one by one

All 21 patterns from the changelog, and the Attachment and Questionnaire components it names. (a)
built on data the log already holds; (b) built with a small optional wire addition (only
Reasoning, which also needed the user's decision below); (c) needs a product or spec decision, or has no data source. "Had" means adopted before
this round.

| Pattern | Decision | What it is here |
| --- | --- | --- |
| Chat | had | MessageScroller |
| Message | had | ai-elements/message |
| Prompt Input | had | ai-elements/prompt-input |
| Queue | had | ai-elements/queue |
| Context | had | ai-elements/context (a Popover) |
| Tool | had | ai-elements/tool |
| Terminal | had, as Tool | A Bash call is a Tool line with its command and output. The pattern's extras need what we don't have: output streamed while it runs (Claude Code sends a tool's result whole) and an exit code (the log keeps the output and the E28 flag, not a code) |
| Model Selector | (a) built | With a mouse; the native select stays on touch |
| Attachment | (a) built | The composer tray's tiles (a message's thumbnails stay plain links) |
| Plan | (a) built | A TodoWrite call's row, from its logged input. TodoWrite is in the default `master.tools` (below) |
| Sources | (a) built | WebFetch addresses and WebSearch result links, under the turn's last reply |
| Subagent | (a) built | M7a (below): Background work's cards |
| Task | (c) | Below, with TodoWrite: no title per group of tool lines in the log |
| Reasoning | (b) built | Above the reply or tool call it came before, from the thinking kept beside the log (below; SPEC "Reasoning") |
| Chain of Thought | (c) | Its "Researched in 3 steps" summary over a turn's tool lines would fold the work log DESIGN.md keeps as one line per call |
| Confirmation | (c), no data | Turns run with `permissionMode: "bypassPermissions"` (ref D9) under `claude -p`, which can't stop for an answer: there is no approval to show |
| Questionnaire | (c), no data | Claude Code's AskUserQuestion isn't in the turn's tools and can't wait for an answer under `-p`; a question the model asks is its reply, answered by the next message |
| Checkpoint | (c), against the design | Restore drops every message after a point. Our log is append-only and is the memory (docs/optchat.md §1); the summary tree's nodes are summaries, not points to return to |
| Suggestion | (c), no data | One endless chat with no "new chat": suggestions would be prompts we invent |
| File Tree | (c) | The files a turn changed could come from its Edit and Write calls, but not from Bash (`sed -i`, `git mv`), so the tree would be wrong in the way that matters; one row per call already names each file |
| Inline Citation | (c), no data | Claude Code's reply carries no citation spans, and a Hover Card can't open on a phone; Sources covers the links |
| Stack Trace | (c), no data | A failed tool's output is text; frames would be parsed out of it, which E28 rules out for failure itself ("never guessed from what the output says") |
| Test Results | (c), no data | Same: suites and failures would be parsed from a test runner's text |

### For a decision

**Reasoning.** Built after the user chose option 2 below ("Reasoning in side file makes sense").
The options were: (1) *stream only*, the text as AG-UI's REASONING_* events, kept in memory for the
running turn and gone on a reload, so a reply reads differently live and later; (2) *beside the
memory*, a side file keyed by log index that the tree, the view and every request never read; (3)
*in the log*, a new kind or key in `main`, which breaks parity and either enters the view or needs
a rule to skip it everywhere: the mistake docs/optchat.md §7 names. What ships (SPEC "Reasoning",
E29): (2), streamed live as (1) does. `chat/reasoning/YYYY-MM-DD.jsonl` beside `main/` and `tree/`,
one piece per reply or tool call it came before, capped per piece and per turn, committed with the
data dir unless `reasoning.commit` is off. Its costs are the ones listed then: the largest thing a
turn writes, kept and pushed, and the log is no longer the one source of what the page shows. The
component is `ai-elements/reasoning.tsx` on Trace, and differs from the pattern as the table says.

**Subagent (M7a).** Built and wired: `chat/subagents.tsx` fills Background work's `extra` slot with a
"Subagents" group, one `Subagent` card per entry of `SessionState.subagents` (optional, so old
clients and servers still decode): every running subagent, then the newest others. A card's steps
are the tool and echo pairs of its side log, read from `GET /api/subagent?name&from` as the state's
`entries` count grows (only the new entries); its report is the side log's last reply. Its frames
are `{"type":"tell","name","text"}`, `{"type":"stop-subagent","name"}` and
`{"type":"subagent-model","name","model"}`; what the server refuses comes back as an `info`. The
server also sends AG-UI's SUBAGENT_STARTED, SUBAGENT_FINISHED and SUBAGENT_ERROR, which the client
decodes and leaves to the state. The model is the composer's Model Selector (`ModelPicker` with a
label, a test id and the server's label for a ref that is none of the chain's entries), for the
subagent's next call. Still open: a report reaches the chat as a `user` entry starting `[Name] `
(E23) and reads as a user message there; marking it as a report is M7b.

**TodoWrite, and with it Task.** The user chose to turn TodoWrite on, so Plan shows in real
claude-code turns: the turn's `--tools` is `master.tools`, which defaults to Bash, Read, Edit, Write, Glob,
Grep, WebFetch, WebSearch and TodoWrite (`MASTER_TOOLS`, src/config.ts). What it costs: every
claude-code turn's and compaction's request carries one more tool definition (the tools are part of the cached
prefix, so the first request after the change rewrites the cache once, then it is stable); every
TodoWrite call becomes a `tool` and `echo` pair in the log, so in memory, summarized and zoomable
like any other call, and Claude Code calls it often on longer work. A config that sets its own
`master.tools` keeps its list. OpenAI-plan and API-key turns and compactors use the device's
`ToolDef`s instead, so their tool prefix is unchanged. After deployment, watch existing usage logs
and failover notices for "the compactor called a tool": TodoWrite may be used proactively, but
compaction still kills a try as soon as any tool call starts. Task (the steps under what the agent is doing) needs a title per
group of tool lines that the log doesn't hold; the step in progress at the time could be that title
for the calls after it. Not built.
