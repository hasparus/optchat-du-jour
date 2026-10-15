# Where the web UI's components come from

shadcn/ui first (DESIGN.md, Components). Each file in `src/components` is either the registry's,
changed only where the app needs it, or ours for a stated reason. Checked against the registry on
2026-10-14, after shadcn's
[October 2026 changelog](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements) (Trace, Code
Block, AI Elements as patterns).

## How they come in

- **CLI.** `shadcn` is pinned exactly in `package.json` (4.21.5) and used with `add --dry-run --view`
  or `--diff`. Files are written by hand from what it shows, for two reasons:
  - Items from the radix-* styles import `cn` from the npm package `cn`, and a plain `add` would
    install it. Ours stays in `src/lib/utils.ts`: its tailwind-merge knows the theme's own sizes
    (text-ui, text-read, text-2xs) and shadows.
  - `add` can't resolve a radix-* item's dependencies while `components.json` names new-york.
- **Styles.** new-york-v4 for everything it carries. radix-vega, its closest relative, for Trace
  and Code Block, which only the radix-* and base-* styles have.
- **vaul.** 1.1.2, exact, for shadcn's Drawer. It is vaul's last release (December 2024), and its
  README says the project is unmaintained. It is kept by choice: check it on devices (TODO.md).

## Component by component

| Component | Source | Ours differs | Why |
| --- | --- | --- | --- |
| ui/trace | radix-vega | lint-only edits | — |
| ui/code-block, hooks/use-highlighted-code, lib/highlighter | radix-vega | themes; lazy load | GitHub's high-contrast pair (the default's #e36209 reads 3.5:1). shiki loads on first use, out of the startup bundle |
| ui/drawer | new-york-v4 (vaul) | the grabber in `bg-soft-strong` | It shows on glass. The app's one sheet, dressed in `components/sheet-drawer.tsx` |
| ui/tooltip | new-york-v4 | — | One provider at the app root |
| ui/collapsible, badge, input, textarea, marker, message, popover | new-york-v4 | — | — |
| ui/bubble | new-york-v4 | a `soft` variant | The user's bubble |
| ui/button, ui/input-group | new-york-v4 | touch sizes, `icon-md` | 40 px touch targets. 36/40 px round send and stop |
| ui/progress, ui/tabs | new-york-v4 | `??` for `\|\|`; muted tab text | Lint. AA for inactive tabs |
| ui/message-scroller | new-york-v4 over @shadcn/react | re-exports the package's hooks | Lint |
| ui/chart | new-york-v4, cut down | only what Stats uses | — |
| ui/segmented | ours | — | shadcn has no segmented control |
| ai-elements/tool | the Tool pattern on Trace and Code Block | Failed from the logged flag only | SPEC E28 |
| ai-elements/queue | the Queue pattern on Trace | items wrap; take-back beside them | A held message shows text, thumbnails and its engine |
| ai-elements/message | the Message pattern (MessageFooter, Tooltip) | the footer's slot is `message-actions`; Streamdown hardened | Tap-to-reveal finds the row by it. No remote images; no downloads in the iOS app |
| ai-elements/shimmer | shadcn's `shimmer` utility | rests muted, sweeps to ink; plain text without color-mix | AA throughout. Old Safari |
| ai-elements/context | ours | a Popover, not the pattern's Hover Card | A phone can't hover |
| ai-elements/prompt-input | ours on Input Group | — | Glass composer, held tray, iOS file inputs inside the tap, drafts, upload progress (Attachment has none) |

## Not adopted yet

- The `cn` package.
- A radix-* style for the whole app.
- Attachment for the composer's tray.
- The patterns for what we don't log or do: Reasoning, Sources, Plan, Task, Confirmation,
  Checkpoint, Model Selector, Suggestion, Questionnaire.
- Subagent, until the server reports subagents (M7). It belongs in Background work.
