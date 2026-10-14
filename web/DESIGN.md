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
- **Raised** (white; dark `0.225`): the composer, popovers, the active tab, the tray above the composer.
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
  iOS app, server) at the right.
- **Phone.** 390 px: one ground, a hairline under the header, the composer docked at the bottom with
  the home-indicator inset; at 360 px nothing scrolls sideways.

## Elevation & Depth

Flat by default; depth comes from the two grounds and hairlines. Shadows are reserved for the one
raised object (the composer) and for things that float over content.

### Shadow Vocabulary
- **Raised** (`--elevation-raised`: `0 1px 2px oklch(0 0 0 / 4%), 0 12px 28px -18px oklch(0 0 0 /
  32%)`; dark: an inset 1 px top highlight and `0 14px 32px -18px` at 70%): the composer's drop,
  under its ring and sheen (`composer-surface`, Components).
- **Float** (`shadow-float`: a 1 px hairline ring over `0 2px 6px -2px oklch(0 0 0 / 8%), 0 12px
  32px -12px oklch(0 0 0 / 22%)`): popovers, the Add context sheet, the scroll-to-end button, the
  context meter's card.
- **Lift** (`shadow-lift`: a hairline ring and `0 1px 2px` at 6%): the chosen item of a segmented
  control.

### Named Rules
**The One Raised Object Rule.** Only the composer is lifted at rest. A card inside a sheet gets a
hairline, never a shadow.

## Shapes

Radii from one base (10 px): 6 (inline code), 8 (buttons, tabs, rows' hover wash), 10 (tool panel,
tool code), 14 (code blocks, tables, lists of devices, stat strip), 18 (bubbles), 22 (the
composer), full (send, stop, pickers, chips, the scroll button). The tray attached above the
composer has 14 px top corners and no bottom edge, so it reads as part of it.

## Components

shadcn/ui first: the primitives in `components/ui` are the registry's (new-york-v4, and radix-vega
for Trace, Code Block and Drawer, which new-york-v4 doesn't carry), and the AI Elements wrappers in
`components/ai-elements` follow the October 2026 patterns built on them. Where ours differ, the
reason is a behaviour the app needs (a touch target, the iOS WebView, contrast); the list is in the
PR's registry table.

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

### Composer
Modelled on Claude's app: a soft, translucent card with round controls.

- **Surface** (`composer-surface` in `index.css`): 28 px radius. Its ground is the raised colour at
  80% (`--composer-ground`), over a 16 px backdrop blur saturated to 150%, so what scrolls under it
  shows through softly. Where the browser has no backdrop-filter, or the reader asked for less
  transparency (`prefers-reduced-transparency`), the ground is opaque. The border is a 1 px ring
  drawn as a box-shadow (`--composer-ring`: ink at 13%, dark white at 11%), never a CSS border. A
  sheen lights the top edge: a 1 px inset highlight (`--composer-sheen`: white at 95%, dark 10%)
  and a fill fading from white at 70% (dark 4%) to nothing by 44 px (`--composer-sheen-fill`).
  Under it, the Raised drop. With the text focused the ring turns ivy at 65% with a 4 px ivy halo
  at 14%; a dragged file does the same, stronger.
- **Floating:** the dock floats over the end of the transcript, which scrolls on under it. The
  content keeps `--dock-h` clear below its last row, and the scroller's `scroll-padding-bottom` is
  `--dock-h` too, so focus never leaves a control under the dock (WCAG 2.2, 2.4.11). A fade runs from clear 24 px above the dock
  to the sheet at 80% by 3rem and solid at the bottom, so what passes under the composer is soft
  and its text stays legible. Measured with a code block under it and no blur at all, the worst
  case: ink 12.6:1, the placeholder 5.7:1 (light) and 5.8:1 (dark).
- **Text:** Read type, 52 px tall at rest, grows to 12rem or 40% of the viewport.
- **Controls:** at the left, bare: "+" as an icon, its glyph on the start of the text above it, then
  the model, the device and the follow-up mode as plain 13 px labels (the model's effort, when the
  server's engine label names one, beside its name; a chevron on each picker, over the phone's own
  select). No fill and no padding: muted, ink on hover or while open, the focus ring 4 px out. Each
  has an invisible hit area of at least 40 × 40 px (the `bare-control` utility's `::before`, or the
  select laid over the same area), 6 px wider than its label each side; the 18 px gap between them
  keeps the targets from overlapping. At the right, send: a 36 px ink circle with an arrow (40 px on touch), a soft circle
  with a muted arrow when there is nothing to send. While a turn runs: the other way to send as a
  soft pill (icon only under 400 px), and Stop as an ink square on a soft circle. Under 420 px,
  with that second button showing, the device picker makes room. No microphone: the phone's
  keyboard dictates.
- **Sheets:** the app has one, `components/sheet-drawer.tsx`: shadcn's Drawer on vaul (1.1.2,
  pinned; vaul is unmaintained since December 2024, kept by choice). From the bottom edge on a
  phone (24 px top corners, vaul's grabber, a drag down closes it), from the right as a side panel
  on a wide screen; a title and a 40 px close button, on the raised ground with the Float shadow.
- **Add context:** "+" opens it. On a touch screen it is the sheet from the bottom edge; with a
  mouse, a 256 px popover over the "+",
  but only when there is more than one choice: a mouse has no camera choice, so there "+" opens
  the photos-and-videos picker itself. Sheet and popover trap focus, close on Escape or a tap
  outside and give focus back to "+". The choices are rows
  with a 36 px soft icon tile, a label and a muted hint: "Photos & videos" (the library or files,
  images and videos, several at once) and, on a touch screen, "Camera" (`capture`, the rear
  camera). A choice opens the composer's own hidden picker from the tap, then closes the sheet.
- **Tray:** what belongs to the composer sits in a tray attached to its top edge, inset 10 px: the
  held banner (amber ground) and the queue of waiting messages, separated by a hairline.
- **Status:** above it, one 12 px line: a breathing ivy dot and the shimmering status while a turn
  runs; muted text for connecting or reconnecting.
- **Hint:** under it, centred, 11 px muted: the shortcuts on a keyboard, or why send is off.

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
over status text and a running tool's title, a 1.6 s breathing dot. Buttons press to 95-97%. A tool line opens with Trace's
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
  things with `composer-surface` (the composer only), `shadow-float` and `shadow-lift`, never a
  one-off shadow.
- **Do** theme browser surfaces: selection, caret, scrollbars and focus rings come from the palette.

### Don't:
- **Don't** put a reply in a bubble or a card, or your message in plain text.
- **Don't** colour the primary button; ink is the primary.
- **Don't** box things inside the sheet with shadows; use a hairline.
- **Don't** use mono for anything that isn't code, a command, a path, an id or output.
- **Don't** add a second accent, a coloured side border, or glass or a gradient as decoration. The
  composer is the one glass surface (a blur behind it, so the transcript runs on underneath), and
  three gradients do jobs and are the only ones: the fade under the composer's dock, the composer's
  top sheen, and shadcn's `shimmer` sweeping a highlight over live status (the text at full ink
  between sweeps).
- **Don't** set text you read or type under 16 px on a touch screen.
