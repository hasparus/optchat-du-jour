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
    fontFamily: "Schibsted Grotesk Variable, -apple-system, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  read:
    fontFamily: "Schibsted Grotesk Variable, -apple-system, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  ui:
    fontFamily: "Schibsted Grotesk Variable, -apple-system, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.25rem
  meta:
    fontFamily: "Schibsted Grotesk Variable, -apple-system, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1rem
  code:
    fontFamily: "Commit Mono, ui-monospace, SF Mono, Menlo, monospace"
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
markdown) and the components' own classes. It replaced the three trial looks of the UI audit
(`?variant=a|b|c`). Sources and measurements behind it are in the design notes of PR #29.

## Overview

**Creative North Star: "The quiet sheet"**

A conversation set on a near-white sheet inside a grey frame, the way Amp sets its transcript: what
you said in a soft bubble on the right, what came back as plain prose on the left (Claude), and the
work in between as a ledger of one-line rows (T3 Code's work log). The composer is the one object
with weight. Everything else is hairlines, grey type and space.

The chat is endless and personal, read on a phone as often as at a desk, in the morning and late
at night. It should feel calm enough to live in and dense enough to work in: 15 px prose at a 1.65
line height beside 13 px chrome. Colour is spent on state, never on decoration.

**Key Characteristics:**
- Two grounds: a grey frame (`shell`) and a lighter sheet (`sheet`) on wide screens; one ground on a phone.
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
- **Shell** (`oklch(0.963 0.004 150)`; dark `0.155`): the frame around the sheet on wide screens, the
  header there.
- **Sheet** (`oklch(0.992 0.002 150)`; dark `0.185`): where the conversation and every screen sit.
- **Raised** (white; dark `0.225`): the composer, popovers, the active tab, the tray above the composer.
- **Bubble** (`oklch(0.945 0.005 150)`; dark `0.265`): your messages.
- **Code ground** (`oklch(0.975 0.003 150)`; dark `0.16`, darker than the sheet): code blocks and the
  tool panel.
- **Ink muted** (`oklch(0.5 0.009 150)`; dark `0.7`): secondary text, tool lines, metadata. 5.8:1 on
  the muted fill in light, 6.4:1 in dark.
- **Hairline** (ink at 10%; dark white at 9%) and **strong hairline** (16% / 14%): every border.

### Named Rules
**The Ink Rule.** The primary button is ink, never a hue. Ivy marks state; it never fills a button.

**The State-Only Rule.** Every colour other than the neutrals and ivy means something: green
connected, amber held, red failed. If it means nothing, it is grey.

**The Same-Structure Rule.** Dark mode is the light structure with its values inverted: the frame is
darker than the sheet, code is darker still, text is 93%, never pure white on pure black.

## Typography

**Body Font:** Schibsted Grotesk (variable, 400-900, self-hosted, OFL), falling back to the platform UI face.
**Mono Font:** Commit Mono (400, self-hosted, OFL), falling back to `ui-monospace`.

**Character:** a crisp newspaper grotesk, slightly narrow, confident at 13 px and easy at 15 px, with
a neutral mono close in spirit to Amp's Berkeley Mono. One family carries prose, labels and data.

### Hierarchy
- **Heading** (600, 1.3em of prose / 1rem screen titles, 1.3, -0.012em): headings in replies and the
  title of each screen ("Memory", "Stats", "Devices"). Balanced wrapping.
- **Read** (400, 15 px, 16 px on a touch screen, 1.65): your messages, replies, memory summaries, the
  composer's text. Replies keep a 68ch measure.
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
- **Frame.** From 768 px the header sits on the shell and each screen is a sheet inset 8 px from
  the window's sides and bottom, 18 px radius, a hairline, and a 1 px shadow.
- **Rhythm.** Rows 12 px apart; a new turn (your message) 24 px; consecutive tool rows 2 px, so a run
  of calls reads as one list; a reply 8 px after a tool row. 24 px above the first row, 40 px below
  the last. Screen pages: 24 px top, 20 px between sections.
- **Header.** 48 px plus the safe area. Tabs as a segmented control on the left; theme (and in the
  iOS app, server) at the right.
- **Phone.** 390 px: one ground, a hairline under the header, the composer docked at the bottom with
  the home-indicator inset; at 360 px nothing scrolls sideways.

## Elevation & Depth

Flat by default; depth comes from the two grounds and hairlines. Shadows are reserved for the one
raised object (the composer) and for things that float over content.

### Shadow Vocabulary
- **Raised** (`0 1px 2px oklch(0 0 0 / 4%), 0 12px 28px -18px oklch(0 0 0 / 32%)`; dark: an inset
  1 px top highlight and `0 14px 32px -18px` at 70%): the composer, always paired with a 1 px ring.
- **Float** (`0 2px 6px -2px oklch(0 0 0 / 8%), 0 12px 32px -12px oklch(0 0 0 / 22%)`): popovers,
  the scroll-to-end button, the context meter's card.
- **Sheet** (`0 1px 2px oklch(0 0 0 / 4%)`): the screen sheet on wide screens.

### Named Rules
**The One Raised Object Rule.** Only the composer is lifted at rest. A card inside a sheet gets a
hairline, never a shadow.

## Shapes

Radii from one base (10 px): 6 (inline code), 8 (buttons, tabs, rows' hover wash), 10 (tool panel,
tool code), 14 (code blocks, tables, lists of devices, stat strip), 18 (bubbles, the sheet), 22 (the
composer), full (send, stop, pickers, chips, the scroll button). The tray attached above the
composer has 14 px top corners and no bottom edge, so it reads as part of it.

## Components

### Messages
- **Yours:** a bubble on the right, `bubble` fill, 18 px radius, 8 × 14 px padding, Read type, max
  85% (80% and 36rem from `sm`). Attachments as rounded thumbnails above it; their marker lines in
  mono 12 px muted inside it.
- **Note:** the same bubble, outlined with a dashed strong hairline, muted text, a small "Note" label
  with a pen icon above.
- **Reply:** no container. Read type, markdown styled by `[data-prose]` in `index.css`. Under it,
  Copy and Raw (28 px ghost icons), shown on hover or focus with a mouse, always on a touch screen;
  hidden while it streams, when a circle caret marks the end.

### Tool calls (signature)
- **Line:** 28 px tall (40 px on touch), a 14 px icon for the kind of tool (terminal, file, pencil,
  search, globe, memory zoom), the tool name in UI weight, then what it was called on in mono 12 px
  muted, truncated: the command, the file, the pattern, a memory node as `id+n`. A hover wash bleeds
  8 px past the text on both sides; a chevron appears on hover and turns when open.
- **States:** running: the icon breathes and the name shimmers. Done: nothing (the norm, "Completed"
  for screen readers). No output: "No output" in muted 12 px. Failed (the output starts with a
  non-zero exit code, `<tool_use_error>` or `Error:`): red icon and "Failed".
- **Open:** one panel indented under the name: code ground, 10 px radius, hairline; "Input" (the JSON
  as logged, highlighted) and "Output" or "Error" with a copy button, separated by a hairline.

### Composer
- **Surface:** raised, 22 px radius, a 1 px strong-hairline ring and the Raised shadow. With the text
  focused the ring turns ivy at 65% with a 4 px ivy halo at 14%; a dragged file does the same.
- **Text:** Read type, 52 px tall at rest, grows to 12rem or 40% of the viewport.
- **Footer:** attach and camera (32 px round ghost icons), then the device and model pickers and the
  follow-up mode as round ghost pills (13 px, muted, ink on hover), then send at the right: a 32 px
  ink circle with an arrow (40 px on touch), muted fill when disabled. While a turn runs: the other
  way to send as an outlined pill, and Stop as a red-outlined circle with a filled square.
- **Tray:** what belongs to the composer sits in a tray attached to its top edge, inset 10 px: the
  held banner (amber ground) and the queue of waiting messages, separated by a hairline.
- **Status:** above it, one 12 px line: a breathing ivy dot and the shimmering status while a turn
  runs; muted text for connecting or reconnecting.
- **Hint:** under it, centred, 11 px muted: the shortcuts on a keyboard, or why send is off.

### Navigation
- **Tabs:** a segmented control of text tabs (13 px, 500). Active: raised fill, ink text, a hairline
  ring and a 1 px shadow. Inactive: muted, hover wash. On a phone they share the row evenly.
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

150-200 ms for state; `cubic-bezier(0.22, 1, 0.36, 1)` for anything that moves in, `cubic-bezier(0.32,
0.72, 0, 1)` for drawers. Live state is told by small motion: a 2.2 s shimmer over status text and a
running tool's name, a 1.6 s breathing dot. Buttons press to 95-97%. A tool panel fades and slides
1 px in. No entrance choreography on load. Under `prefers-reduced-motion` every animation and
transition stops; state still reads from text and colour (the shimmer becomes plain muted text).

## Do's and Don'ts

### Do:
- **Do** put new colours through the tokens in `src/index.css`, in both themes, and check them at 4.5:1 for text.
- **Do** keep tool calls to one line until opened, and say only the states worth reading.
- **Do** attach anything about the next message (held, queued, an approval later) to the composer's tray.
- **Do** keep hit targets at 40 px on touch (`pointer-coarse:`), 28-32 px with a mouse.
- **Do** theme browser surfaces: selection, caret, scrollbars and focus rings come from the palette.

### Don't:
- **Don't** put a reply in a bubble or a card, or your message in plain text.
- **Don't** colour the primary button; ink is the primary.
- **Don't** box things inside the sheet with shadows; use a hairline.
- **Don't** use mono for anything that isn't code, a command, a path, an id or output.
- **Don't** add a second accent, gradients, glass, or a coloured side border.
- **Don't** set text you read or type under 16 px on a touch screen.
