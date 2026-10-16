---
name: optchat
description: One endless personal chat whose memory is a summary tree. The web UI's one visual language.
colors:
  shell: "oklch(0.963 0.004 150)"
  sheet: "oklch(0.992 0.002 150)"
  raised: "oklch(1 0 0)"
  ink: "oklch(0.21 0.008 150)"
  ink-muted: "oklch(0.5 0.009 150)"
  bubble: "oklch(0.945 0.005 150)"
  code-ground: "oklch(0.975 0.003 150)"
  fill-muted: "oklch(0.958 0.004 150)"
  hairline: "oklch(0.21 0.008 150 / 10%)"
  hairline-strong: "oklch(0.21 0.008 150 / 16%)"
  ivy: "oklch(0.5 0.12 158)"
  live-green: "oklch(0.6 0.14 155)"
  amber: "oklch(0.74 0.15 72)"
  amber-ink: "oklch(0.47 0.1 62)"
  amber-ground: "oklch(0.97 0.03 80)"
  red: "oklch(0.55 0.2 27)"
  dark-shell: "oklch(0.155 0.004 150)"
  dark-sheet: "oklch(0.185 0.005 150)"
  dark-raised: "oklch(0.225 0.005 150)"
  dark-ink: "oklch(0.93 0.004 150)"
  dark-ink-muted: "oklch(0.7 0.008 150)"
  dark-bubble: "oklch(0.265 0.006 150)"
  dark-code-ground: "oklch(0.16 0.004 150)"
  dark-ivy: "oklch(0.8 0.12 158)"
  dark-red: "oklch(0.7 0.17 25)"
typography:
  heading:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk Fallback, -apple-system, system-ui, sans-serif"
    fontSize: "1.40625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  read:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk Fallback, -apple-system, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  ui:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk Fallback, -apple-system, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.25rem
  meta:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk Fallback, -apple-system, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1rem
  code:
    fontFamily: "Commit Mono, Commit Mono Fallback, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "18px"
  3xl: "22px"
  full: "9999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.raised}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-send:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.raised}"
    rounded: "{rounded.full}"
    size: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.full}"
    height: "28px"
    padding: "0 10px"
  bubble-user:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.ink}"
    typography: "{typography.read}"
    rounded: "{rounded.2xl}"
    padding: "8px 14px"
  composer:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.3xl}"
  tool-row:
    textColor: "{colors.ink-muted}"
    typography: "{typography.ui}"
    height: "28px"
  code-panel:
    backgroundColor: "{colors.code-ground}"
    typography: "{typography.code}"
    rounded: "{rounded.xl}"
  tab-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
---

# Design System: optchat

The web UI (`web/`) has one look, defined here and implemented in `src/index.css` (tokens, base,
markdown, the `hairline` and `bare-control` utilities, the shadow tokens) and the components' own
classes; the segmented control is `components/ui/segmented.tsx`. Sources and measurements behind it
are in the design notes of PR #29.

## Overview

**Creative North Star: "The quiet sheet"**

A conversation set on a near-white sheet under a grey band, Amp's two grounds: what you said in a soft bubble on the right, what came back as plain prose on the left (Claude), and the
work in between as a ledger of one-line rows (T3 Code's work log). The composer is the one object
with weight. Everything else is hairlines, grey type and space.

The chat is endless and personal, read on a phone as often as at a desk, in the morning and late
at night. It should feel calm enough to live in and dense enough to work in: 15 px prose at a 1.65
line height beside 13 px chrome. Colour is spent on state, never on decoration.

**Key Characteristics:**
- Two grounds: a grey band for the header (`shell`) and a lighter sheet (`sheet`) below it on wide screens; one ground on a phone.
- Your words in a filled bubble; the model's words with no container at all.
- Tool calls as single quiet lines that open into one bordered panel.
- Ink is the primary colour; ivy green is the only accent and marks state.
- Hairlines (alpha borders) instead of boxes; one soft shadow, under the composer and floating things.

## Colors

Neutrals carry a trace of the accent's green (hue 150, chroma under 0.01) so grey never reads as
dead; ivy is the one accent. Light and dark are the same structure, not two designs.

### Primary
- **Ink** (`oklch(0.21 0.008 150)`; dark `oklch(0.93 0.004 150)`): body text, the send button, the
  primary button ("Continue with…"). The main action is the text colour, as in Amp and ChatGPT.

### Secondary
- **Ivy** (`oklch(0.5 0.12 158)`; dark `oklch(0.8 0.12 158)`): focus rings, links in replies, the
  composer's focus ring, text selection (24%), the caret, the "this server" chip, the context
  meter's arc, the live dot of a running turn, the HD toggle when on. 5.5:1 on the sheet in light,
  10:1 in dark.

### Tertiary (state only)
- **Live green** (`oklch(0.6 0.14 155)`): the connection dot when connected.
- **Amber** (`oklch(0.74 0.15 72)` icon, `oklch(0.47 0.1 62)` text on `oklch(0.97 0.03 80)`): a turn
  stopped on a usage limit or an offline device (the held banner). A limit is a warning, not an error.
- **Red** (`oklch(0.55 0.2 27)`; dark `oklch(0.7 0.17 25)`): a failed tool call, an error marker, a
  failed upload, the Stop button's outline.

### Neutral
- **Shell** (`oklch(0.963 0.004 150)`; dark `0.155`): the header band on wide screens.
- **Sheet** (`oklch(0.992 0.002 150)`; dark `0.185`): where the conversation and every screen sit.
- **Raised** (white; dark `0.225`): popovers, the active tab; in dark also the glass's tint (the composer, its tray, the sheets; light glass is `0.97`, Components: Glass).
- **Bubble** (`oklch(0.945 0.005 150)`; dark `0.265`): your messages.
- **Code ground** (`oklch(0.975 0.003 150)`; dark `0.16`, darker than the sheet): code blocks and the
  tool panel.
- **Ink muted** (`oklch(0.5 0.009 150)`; dark `0.7`): secondary text, tool lines, metadata. In light
  5.84:1 on the sheet and 5.29:1 on the muted fill; in dark 5.91:1 on the muted fill (6.99:1 on the
  sheet).
- **Hairline** (ink at 10%; dark white at 9%) and **strong hairline** (16% / 14%): every border.

### Named Rules
**The Ink Rule.** The primary button is ink, never a hue. Ivy marks state; it never fills a button.

**The State-Only Rule.** Every colour other than the neutrals and ivy means something: green
connected, amber held, red failed. If it means nothing, it is grey.

**The Same-Structure Rule.** Dark mode is the light structure with its values inverted: the band is
darker than the sheet, code is darker still, text is 93%, never pure white on pure black.

## Typography

**Body Font:** Schibsted Grotesk (variable, 400-900, self-hosted, OFL), falling back to the platform UI face.
**Mono Font:** Commit Mono (400 only, self-hosted, OFL), falling back to `ui-monospace`. There is no
bold mono: code inside bold text stays at 400 (`font-synthesis-weight: none`), and nothing sets mono
in a heavier weight.

Until each face loads, a local face scaled to its metrics stands in ("Schibsted Grotesk Fallback"
over Arial, "Commit Mono Fallback" over Menlo, in `src/fonts.css`), and `index.html` preloads the
two latin files every screen needs first, so the swap moves nothing.

**Character:** a crisp newspaper grotesk, slightly narrow, confident at 13 px and easy at 15 px, with
a neutral mono close in spirit to Amp's Berkeley Mono. One family carries prose, labels and data.

### Hierarchy
- **Heading** (600, 1.3, -0.012em, balanced wrapping): in replies h1 at 1.5em, h2 at 1.27em, h3 to
  h6 at 1em, set apart by weight. Each size step is at least 1.25× the one below it.
- **Screen title** (600, 1rem): the title of each screen ("Memory", "Stats", "Devices").
- **Read** (400, 15 px, 16 px on a touch screen, 1.65): your messages, replies, memory summaries, the
  composer's text. Replies keep a 58ch measure: about 75 characters of this narrow face (68ch came
  out at 88).
- **UI** (500, 13 px, 20 px): tabs, pickers, tool lines, buttons, table text.
- **Meta** (500, 11 px, 16 px): section labels in the tool panel, the queue header, the shortcut hint.
- **Code** (400, 12-13 px, 1.6): code blocks, tool inputs and outputs, paths, model ids.

### Named Rules
**The 16 px Rule.** On a touch screen, what you read and type is never under 16 px (iOS zooms into
smaller inputs).

**The Mono-Means-Code Rule.** Mono is for code, commands, paths, ids and output. Never as a costume
for labels.

## Layout

- **Column.** The transcript and the composer share one column, 46rem (736 px) wide, with a
  16 px gutter (24 px from `sm`), plus `env(safe-area-inset-*)` on every edge.
- **Grounds.** From 768 px the header sits on the shell band, a hairline under it, and each screen
  fills the window below on the sheet, edge to edge. The sheet is not inset or rounded: a rounded
  sheet would make every bordered thing on it a card in a card.
- **Rhythm** (the visible gap between rows). Rows 12 px apart; a status marker 12 px from the rows
  either side; a new turn (your message) 24 px; consecutive tool rows 2 px, so a run of calls reads
  as one list; a reply and a tool row 8 px. A row is drawn with `content-visibility`, which clips
  its paint to its box, so each row keeps 4 px above and below and 8 px either side inside it, for a
  focus ring or a hover wash, and its margins give that room back (`index.css`, the transcript's
  rhythm). The content has 24 px above the first row and 40 px below the last. Screen pages: 24 px
  top, 20 px between sections.
- **Header.** 48 px plus the safe area. Tabs as a segmented control on the left; theme (and in the
  iOS app, server) at the right, and from 640 px Background work before them. Under 400 px the
  tabs' padding tightens to 6 px, so at 360 px no two targets overlap (an e2e test checks 360 and
  390 px, in a browser and in the iOS app).
- **Phone.** 390 px: one ground, a hairline under the header, the composer docked at the bottom with
  the home-indicator inset; at 360 px nothing scrolls sideways.

## Elevation & Depth

Flat by default; depth comes from the two grounds and hairlines. Shadows are reserved for glass
(the composer, the tray on it, the sheets) and for things that float over content.

### Shadow Vocabulary
- **Glass** (`glass-surface`, Components: Glass): the composer, the tray on its top edge and the
  sheets. Its drop is `--glass-drop` (`0 12px 28px -18px oklch(0 0 0 / 32%)`; dark `0 14px 32px
  -18px` at 70%): soft, with no contact shadow, so the 1 px ring reads the same weight on every
  edge.
- **Float** (`shadow-float`: a 1 px hairline ring over `0 2px 6px -2px oklch(0 0 0 / 8%), 0 12px
  32px -12px oklch(0 0 0 / 22%)`): popovers, the scroll-to-end button, the context meter's card.
- **Lift** (`shadow-lift`: a hairline ring and `0 1px 2px` at 6%): the chosen item of a segmented
  control.

### Named Rules
**The One Raised Object Rule.** Only the composer is lifted at rest. A card inside a sheet gets a
hairline, never a shadow.

## Shapes

Radii from one base (10 px): 6 (inline code), 8 (buttons, tabs, rows' hover wash), 10 (tool panel,
tool code), 14 (code blocks, tables, lists of devices, stat strip), 18 (bubbles), full (send,
stop, pickers, chips, the scroll button). Glass has one radius,
`--radius-glass` (28 px, `rounded-glass`): the composer's corners, the top corners of the tray on
it (the composer's top corners square under a tray, so the two make one shape) and of a sheet.

## Components

shadcn/ui first: the primitives in `components/ui` are the registry's, in the radix-vega style
(Drawer, Tooltip, Trace, Code Block, Dropdown Menu and Attachment included), and the AI Elements
wrappers in `components/ai-elements` follow the October 2026 patterns built on them. Where
ours differ, the reason is a behaviour the app needs (a touch target, the iOS WebView, contrast):
component by component in [REGISTRY.md](./REGISTRY.md).

### Messages
- **Yours:** a bubble on the right, `bubble` fill, 18 px radius, 8 × 14 px padding, Read type, max
  85% (80% and 36rem from `sm`). Attachments as rounded thumbnails above it; their marker lines in
  mono 12 px muted inside it.
- **Note:** the same bubble, outlined with a dashed strong hairline, muted text, a small "Note" label
  with a pen icon above.
- **Reply:** no container. Read type, markdown styled by `[data-prose]` in `index.css`. Under it,
  Copy and Raw (28 px ghost icons, 40 px on touch), always reachable: with a mouse, hover or focus
  shows them; on a touch screen they wait behind a tap on the reply, as in a messaging app (one
  listener on the transcript hears touch and pen taps; a reply has no click handler of its own). A tap
  shows that reply's actions and hides any other reply's; a tap outside it, or scrolling it out of
  view, hides them; a tap on a link or a button in it, or one that ends a text selection, toggles
  nothing. They open below the reply, where the dock floats over the newest one, so opening the
  newest reply's actions brings the chat to its end (a reader there stays there), and another
  reply's actions scroll just clear of the dock if they need to. Hidden, they stay in the page
  (collapsed), so focus from a keyboard or a screen reader opens them. Raw is there from the first token (SPEC: rendering never hides what the model wrote);
  Copy waits for the whole reply. While a reply streams a circle caret marks its end.

### Tool calls (signature)
Built on shadcn/ui's Trace and Code Block (`components/ui/trace.tsx`, `code-block.tsx`; the October
2026 AI Elements), as the registry's Tool pattern is.

- **Line:** a trace line, 28 px tall (40 px on touch): a 14 px icon for the kind of tool (terminal,
  file, pencil, search, globe, memory zoom), the tool name in UI weight, then what it was called on
  in mono 12 px, truncated: the command, the file, the pattern, a memory node as `id+n`. Muted, ink
  on hover; Trace's chevron follows the title and turns when open.
- **States:** running: Trace's `running` status, the title under shadcn's `shimmer` sweep. Done:
  nothing (the norm, "Completed" for screen readers). No output: "No output" in muted 12 px.
  Failed: Trace's `error` status, the line red and "Failed", when the echo carries the log's error
  flag (Claude Code's `is_error`, or our tool loop's own; SPEC E28, `lib/rows.ts` toolStateOf), and
  only then: never guessed from what the output says, so an echo logged before the flag existed
  reads as done. The output itself always shows as logged.
- **Open:** under Trace's indented rule, two small Code Blocks: "Input" (the JSON as logged,
  highlighted with GitHub's high-contrast pair) and "Output" with a copy button, or for a failed
  call the destructive block titled "Error".
- **Plan** (a TodoWrite call, AI Elements' Plan): the same line with a list-check icon, "Plan" and
  "2 of 4 done" in muted 12 px. Open: a line per step, a 14 px circle (filled check done, dot in
  progress, hollow pending) and its text in 13 px, done ones muted; the step in progress reads in
  its present tense and shimmers while the turn runs. Pending steps are not dimmed (Trace's 60%
  would take muted text under AA). The call's input and output sit behind one more closed line,
  "Input and output". A turn has one plan, its last TodoWrite call: the calls before it read as
  plain tool lines. It is live (shimmering, its step in its present tense) only while its run goes
  on, and only the run's newest plan: a steered message starts a turn of its own, and the plan
  before it closes rather than shimmer beside the new one. The chat's newest plan is open, the
  others closed, until the reader chooses.
- **Sources** (AI Elements' Sources): under a turn's last reply, a line with a globe, "Used 3
  sources". Open: a link per source, its title in ink, its host in muted 12 px, an up-right arrow;
  28 px rows, 40 px on touch. Plain links: no favicons, nothing fetched.
- **Reasoning** (AI Elements' Reasoning, SPEC "Reasoning"): above the reply or tool call the model
  thought before, a line with a brain, "Thought for 12 s" ("Reasoning" under a second), in the same
  row as what follows it: 6 px above a reply, 2 px above a tool line, so before a tool call it reads
  as one more line of the work log. Closed by default, also while it streams, when it reads
  "Thinking…" under the `shimmer` sweep (Trace's running status) and holds the row its entry then
  takes, so nothing jumps when the reply or call arrives. Open: the thought under Trace's indented
  rule in UI type, muted, plain text as written (no markdown: nothing hides what the model wrote,
  so no Raw toggle), and "N more characters were not kept" in muted 12 px when the caps cut it.
  Open or closed is the reader's per row, for this page only. After a reload the text is read when
  the line is first opened ("loading…" shimmering meanwhile); "It wasn't kept." when the server has
  none, "It couldn't be read. Close and open it to try again." when the read failed, which reopening
  does. Open or closed is held by the session store with the piece, so it stays as the reader left
  it when a steered message comes in mid-thought and the thought moves to the row after it.

### Glass
One surface, `glass-surface` in `index.css`, for the composer, the tray on its top edge and every
sheet:

- **Ground:** `--glass-tint` (light `oklch(0.97 0.003 150)`, a step under white so the sheen
  shows; dark the raised colour) at `--glass-alpha` (80%; the sheets 92%) over a 16 px backdrop
  blur saturated to 150%. Opaque (the tint itself) where the browser has no backdrop-filter, or the
  reader asked for less transparency (`prefers-reduced-transparency`).
- **Ring:** 1 px drawn as a box-shadow (`--glass-ring`: ink at 13%, dark white at 11%), never a
  CSS border.
- **Sheen:** 1 px of white inset on the top edge (`--glass-sheen`: white at 100%, dark 10%), and a
  fill fading from white at 35% (dark 4%) to nothing by 44 px. `glass-surface-start` moves both to
  the leading edge (a side panel); `glass-joined` drops both (the composer under a tray, whose own
  top edge carries them).
- **Drop:** `--glass-drop`, soft and edgeless, cast downward: under the composer and a bottom sheet
  it lifts them off the page; a side panel's falls along its whole height and barely shows, so its
  ring and vaul's dimmed page set it off.
- **Radius:** `--radius-glass`, 28 px.
- **Contrast:** muted text on a sheet, at 92%, stays AA (4.6:1) even with black behind it, which
  is darker than anything vaul's dimmed page shows. On the composer, at 80% over the dock's fade:
  ink about 15:1 with dark content under it, the placeholder about 5.1:1 at worst and 5.55:1 with
  nothing under it; AA either way.

### Composer
Modelled on Claude's app: a soft, translucent card with round controls.

- **Surface:** Glass (above), at 80%, on `--radius-glass`; the group inside is see-through and
  clipped to it. With the text focused the ring turns ivy at 65% with a 4 px ivy halo at 14%; a
  dragged file does the same, stronger (`composer-surface`: it changes `--glass-ring` only, two
  layers like the resting ring, so the change animates). Under a tray, the tray takes the same ring
  (`glass-tray`), each clipped where they meet, so focus outlines the one shape.
- **Floating:** the dock floats over the end of the transcript, which scrolls on under it. The
  content keeps `--dock-h` clear below its last row, and the scroller's `scroll-padding-bottom` is
  `--dock-h` too, so focus never leaves a control under the dock (WCAG 2.2, 2.4.11). A fade runs from clear 24 px above the dock
  to the sheet at 80% by 3rem and solid at the bottom, so what passes under the composer is soft
  and its text stays legible. Measured with no blur at all: ink about 15:1 with dark content under
  it, the placeholder about 5.1:1 at worst and 5.55:1 with nothing under it (light); 5.8:1 (dark).
- **Text:** Read type, 52 px tall at rest, grows to 12rem or 40% of the viewport.
- **Controls:** at the left, bare: "+" as an icon, its glyph on the start of the text above it, then
  the model, the device and the follow-up mode as plain 13 px labels (the model's effort, when the
  server's engine label names one, beside its name; a chevron on each picker, over the phone's own
  select). With a mouse the model's chevron opens AI Elements' Model Selector instead: a menu
  (raised, 14 px radius, Float shadow) of the engines grouped under where they run, in 11 px muted
  labels, the chosen one checked, a down one disabled with why in muted text. No fill and no
  padding: muted, ink on hover or while open, the focus ring 4 px out. Each
  has an invisible hit area of at least 40 × 40 px (the `bare-control` utility's `::before`, or the
  select laid over the same area), 6 px wider than its label each side; the 18 px gap between them
  keeps the targets from overlapping. At the right, send: a 36 px ink circle with an arrow (40 px on touch), a soft circle
  with a muted arrow when there is nothing to send. While a turn runs: the other way to send as a
  soft pill (icon only under 400 px), and Stop as an ink square on a soft circle. Under 420 px,
  with that second button showing, the device picker makes room. No microphone: the phone's
  keyboard dictates.
- **Sheets:** the app has one, `components/sheet-drawer.tsx`: shadcn's Drawer on vaul (1.1.2,
  pinned; vaul is unmaintained since December 2024, kept by choice). From the bottom edge on a
  phone (the glass radius, 28 px, on its top corners in place of the Drawer's 10 px; vaul's grabber
  in the soft fill; a drag down closes it), from the right as a side panel on a wide screen; a
  title and a 40 px close button, on Glass at 92%, its sheen along the top edge (a side panel's
  along its leading edge). vaul's overlay dims the page behind (black at 50%), and the strip vaul
  extends past the screen's edge is the glass tint, opaque.
- **Add context:** "+" opens it. On a touch screen it is the sheet from the bottom edge; with a
  mouse, a 256 px popover over the "+",
  but only when there is more than one choice: a mouse has no camera choice, so there "+" opens
  the photos-and-videos picker itself. Sheet and popover trap focus, close on Escape or a tap
  outside and give focus back to "+". The choices are rows
  with a 36 px soft icon tile, a label and a muted hint: "Photos & videos" (the library or files,
  images and videos, several at once) and, on a touch screen, "Camera" (`capture`, the rear
  camera). A choice opens the composer's own hidden picker from the tap, then closes the sheet.
- **Tray:** what belongs to the composer sits in a tray attached to its top edge, as wide as it and
  on the same glass: its top corners on the glass radius, the composer's squared under it, so the
  two make one shape and their rings meet in one line. The tray's top edge carries the sheen; the
  composer under it has none, so the join is that line alone. In it, the held banner (amber ground) and
  the queue of waiting messages, separated by a hairline. The
  attachments above the text are 64 px tiles (shadcn's Attachment): the photo dimmed while it
  uploads, a 4 px progress bar along its foot, a remove button on its corner, HD on the photo; a
  failed one in a red tint and ring, its error under it in red 11 px.
- **Status:** above it, one 12 px line: a breathing ivy dot and the shimmering status while a turn
  runs; muted text for connecting or reconnecting.
- **Hint:** under it, centred, 11 px muted: the shortcuts on a keyboard, or why send is off.

### Background work
Modelled on Claude's "Background tasks" sheet: the app's sheet (`components/sheet-drawer.tsx`), from
the bottom on a phone and from the right as a 384 px side panel on a wide screen. It opens from the
running turn's status line, from a button on the Devices screen, and, from 640 px up, from the
header's activity button (an ivy dot on it while anything runs): a phone's header has no room for a
fifth target beside the tabs, the theme and, in the iOS app, the server button. Groups of trace lines (shadcn's Trace), each group collapsible with its count: "Running" (the
turn: the engine's short name, then "Turn · on mini, 1 min 05 s", a Stop on a soft circle beside it;
the compactor, a line per busy level of the tree), "Waiting for a turn" (each held message, its
take-back beside it), "Subagents" (SPEC M7a: a Subagent line per subagent the server lists,
"Running scout" with Stop beside it and how long it has run, open to its device as a badge and its
model as the composer's Model Selector (for its next call), its task, its steps as tool lines, its
report, and a line to tell it something; "Ran", "Failed to run" or "Stopped" once over, closed,
with the same line to tell it to go on) and "Devices" (each runner, connected, offline or
refused). A line is a 14 px
icon, the title in ink and its kind and state in 12 px muted under it; a failed one is red. Only
what the server tells: no group without lines, and no history of finished work but the subagents
the server still lists; with nothing running it says so in one muted line.

### Navigation
- **Segmented control** (`components/ui/segmented.tsx`): text choices (13 px, 500), 28 px tall,
  40 px on touch. Chosen: raised fill, ink text and the `lift` shadow (a hairline ring and 1 px).
  Others: muted, ink on hover. The app's tabs sit bare on the header band (with a hover wash) and
  share the row evenly on a phone; the Stats toggles sit in a muted well.
- **Connection:** an 8 px dot before the tabs, green with a soft halo when connected, breathing grey
  otherwise; a title says which.

### Markers, banners, pickers
- **Status markers** in the transcript: a centred pill of 12 px muted text with an icon; errors in
  red on an 8% red ground.
- **Held banner:** amber triangle, the engine in semibold and why, "Choose how to go on:" in amber
  ink, then a button per engine (ink for "Continue with…", outlined for "Try … again").
- **Popovers:** raised, 14 px radius, hairline ring, Float shadow, 12 px padding. Choices inside are
  8 px-radius tiles; the chosen one has an ivy ring and an 8% ivy wash.

### Screens
- **Memory:** a title, a muted line saying what it is and its size, the context meter as a pill. Lines
  as full-width rows (mono `id+n`, range, size; the summary in Read type, three lines), a hover wash,
  a chevron on hover. Zoom: back, the node's summary, its children indented behind a hairline.
- **Stats:** a title, then one strip of four figures (20 px semibold over 12 px labels) split by
  hairlines, segmented toggles, charts under hairline-topped section titles (no cards), tables with
  hairline rows and tabular numerals.
- **Devices:** one hairline list in a 14 px-radius raised box; each machine with an icon tile, its
  name, a "this server" ivy chip, its URL and folders in mono.

## Motion

150-200 ms for state; `cubic-bezier(0.22, 1, 0.36, 1)` (`--ease-fluid`) for anything that moves in.
Live state is told by small motion: shadcn's `shimmer` (a 2 s sweep, from `shadcn/tailwind.css`)
over status text, a running tool's title and a thought streaming in, a 1.6 s breathing dot. Buttons press to 95-97%. A tool line opens with Trace's
accordion slide. No entrance choreography on load. Under `prefers-reduced-motion` every animation and
transition stops; state still reads from text and colour (the shimmer stands still in its own colour).

## Do's and Don'ts

### Do:
- **Do** put new colours through the tokens in `src/index.css`, in both themes, and check them at 4.5:1 for text.
- **Do** keep tool calls to one line until opened, and say only the states worth reading.
- **Do** attach anything about the next message (held, queued, an approval later) to the composer's tray.
- **Do** keep hit targets at 40 px on touch, 28-32 px with a mouse. The `icon-sm` size of Button
  and InputGroupButton, the segmented control, the queue's header and the pickers carry the touch
  size themselves (`pointer-coarse:`).
- **Do** draw a hairline with the `hairline` (or `hairline-strong`) utility, and raised or floating
  things with `glass-surface` (the composer, its tray, the sheets), `shadow-float` and
  `shadow-lift`, never a one-off shadow.
- **Do** theme browser surfaces: selection, caret, scrollbars and focus rings come from the palette.

### Don't:
- **Don't** put a reply in a bubble or a card, or your message in plain text.
- **Don't** colour the primary button; ink is the primary.
- **Don't** box things inside the sheet with shadows; use a hairline.
- **Don't** use mono for anything that isn't code, a command, a path, an id or output.
- **Don't** add a second accent, a coloured side border, or glass or a gradient as decoration.
  Glass is for the composer, the tray on it and the sheets (a blur behind them, so the page runs on
  underneath), and three gradients do jobs and are the only ones: the fade under the composer's
  dock, glass's sheen fill, and shadcn's `shimmer` sweeping ink over live status that rests muted,
  so every colour of the band stays AA (and plain text where the browser can't mix colours).
- **Don't** set text you read or type under 16 px on a touch screen.
