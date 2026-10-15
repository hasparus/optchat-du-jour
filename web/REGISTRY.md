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
  text-ui, text-read) and the shadows and hairlines that replace one another, and `bun run
  cn-tables` compiles that with every class group into `src/lib/cn-tables.ts` (`cn build --full`),
  which `src/lib/utils.ts` hands to `cn/engine`. Compiled ahead because `cn/config`'s `createCn`
  compiles at run time and would add 12.6 kB gzipped to the startup bundle; `--full` so the tables
  never depend on which classes the sources happen to use. `utils.test.ts` fails when the tables
  are stale. `cn build` can read `@theme` from a stylesheet, but 0.4.0 takes the `/*` in
  `@source "…/dist/*.js"` for a comment and misses our @theme block, so the config names them.
  Vite aliases `clsx` and `tailwind-merge` to `cn`, so Streamdown and class-variance-authority use
  the same engine and the old packages are out of the bundle; Tailwind skips the tables file.
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
| ui/drawer | radix-vega (vaul) | — | The app's one sheet, dressed in `components/sheet-drawer.tsx` |
| ui/tooltip | radix-vega | lint-only edit | One provider at the app root |
| ui/badge, collapsible, input, textarea, marker, message, popover | radix-vega | — | — |
| ui/chart | new-york-v4, cut down | only what Stats uses | radix-vega's chart is the same for the parts we keep (container, tooltip, legend); its full file adds the payload guessing Stats doesn't need |
| ui/segmented | ours | — | shadcn has no segmented control |
| ai-elements/tool | the Tool pattern on Trace and Code Block | Failed from the logged flag only | SPEC E28 |
| ai-elements/queue | the Queue pattern on Trace | items wrap; take-back beside them | A held message shows text, thumbnails and its engine |
| ai-elements/message | the Message pattern (MessageFooter, Tooltip) | the footer's slot is `message-actions`; Streamdown hardened | Tap-to-reveal finds the row by it. No remote images; no downloads in the iOS app |
| ai-elements/shimmer | shadcn's `shimmer` utility | rests muted, sweeps to ink; plain text without color-mix | AA throughout. Old Safari |
| ai-elements/context | ours | a Popover, not the pattern's Hover Card | A phone can't hover |
| ai-elements/prompt-input | ours on Input Group | — | Glass composer, held tray, iOS file inputs inside the tap, drafts, upload progress |

### What the radix-vega switch changes on screen

Taken before and after at 390 and 1280 px, light and dark (chat, an open tool, the tray, the
follow-ups popover, Background work, Add context, the held banner, a failed tool, Memory, Stats,
Devices), and diffed pixel by pixel. Everything not listed here came out identical (Memory, Stats
and Devices differ only in their timestamps, data and temp paths).

- **Sheets** (Background work, Add context): radix-vega's overlay, black at 10% with a slight
  backdrop blur, where new-york's was black at 50%. The sheet's grabber is 6 px tall, not 8.
- **Small buttons** (the held banner's "Try … again" and "Continue with …", Devices' "Background
  work", Memory's back): 10 px side padding instead of 12, a 1 px press-down, and hover fills from
  `muted` instead of `accent` (the same colour in our theme).
- **Popovers** keep their look: the registry's `ring-1`, `gap-4` and `text-sm` are set back at the
  call sites (`ring-0` under `shadow-float`, which has its own ring; the follow-ups popover's
  `space-y-3` became `gap-3`).
- **The sheet's title** keeps 600 weight (radix-vega's is 500) in `sheet-drawer.tsx`.

## Not adopted yet

- The patterns for what we don't log or do: Reasoning, Sources, Plan, Task, Confirmation,
  Checkpoint, Model Selector, Suggestion, Questionnaire, Attachment.
- Subagent, until the server reports subagents (M7). It belongs in Background work.
