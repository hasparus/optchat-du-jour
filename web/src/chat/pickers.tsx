// The composer's pickers (SPEC "Web UI", Composer): the follow-up setting, the model, and the
// compact native select both the model and the device picker are.
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Link } from "@/lib/connection";
import { cn } from "@/lib/utils";
import type { FollowUp, SessionState } from "@wire";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

// What a message sent mid-run does, in a popover off the tools; its trigger names the behavior
// (on a narrow screen without its icon), so the mode is never hidden.
export function FollowUps({ link, followUp }: { readonly link: Link; readonly followUp: FollowUp }) {
  const choices: readonly { readonly value: FollowUp; readonly label: string; readonly hint: string }[] = [
    { hint: "joins the running turn", label: "Steer", value: "steer" },
    { hint: "waits for the next turn", label: "Queue", value: "queue" },
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button aria-label={`Follow-ups: ${followUp}`} className="bare-control shrink-0 cursor-pointer text-ui font-medium" title="What a message sent while a turn runs does" type="button">
          <SlidersHorizontalIcon aria-hidden="true" className="hidden size-3.5 min-[400px]:block" />
          <span className="capitalize">{followUp}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 rounded-xl border-0 p-3 text-ui shadow-float">
        <p className="font-medium">A message sent while a turn runs</p>
        <div className="grid grid-cols-2 gap-1.5">
          {choices.map((c) => (
            <button
              aria-pressed={followUp === c.value}
              className={cn(
                "rounded-lg px-2.5 py-2 text-left transition-[background-color,box-shadow] active:scale-[0.98]",
                followUp === c.value ? "bg-signal/8 shadow-[inset_0_0_0_1.5px_var(--signal)]" : "hairline hover:bg-accent",
              )}
              key={c.value}
              onClick={() => {
                link.configure({ followUp: c.value });
              }}
              type="button"
            >
              <span className="block font-medium">{c.label}</span>
              <span className="block text-xs text-muted-foreground">{c.hint}</span>
            </button>
          ))}
        </div>
        <p className="text-xs/relaxed text-muted-foreground">Shared by every device. The other button next to send, or Ctrl/⌘+Enter, does the other for one message.</p>
      </PopoverContent>
    </Popover>
  );
}

// "Claude Opus (Claude Code)" → "Opus", "GPT-6.1 Sol (ChatGPT plan)" → "GPT-6.1 Sol", "Claude Opus
// (Claude Code, xhigh)" → "Opus · xhigh": what the closed picker shows on a phone's narrow footer,
// and a queued message names; the options say it all. An effort stays, or one model at two
// efforts would read the same.
export type LabelParts = { readonly name: string; readonly effort: string | null };
export const labelParts = (label: string): LabelParts => {
  const [, name = label, effort] = /^(.*) \([^(),]*(?:, ([^(),]+))?\)$/.exec(label) ?? [];
  return { effort: effort ?? null, name: name.replace(/^Claude /, "") };
};
export const shortLabel = (label: string) => {
  const { name, effort } = labelParts(label);
  return `${name}${effort === null ? "" : ` · ${effort}`}`;
};

// A native select (the phone's own picker) laid over a compact label, so a picker in the footer
// takes the width of its value, not of its longest option. A bare label and a chevron, like every
// control in the footer (bare-control, index.css); the select is laid over the label's invisible
// 40 px hit area, so the whole target opens it. `wide`: the model, which may take more room than
// the device. `down`: what is shown can't take a turn now: a small mark beside it (the title says
// why)
type CompactSelectProps = ComponentProps<"select"> & {
  readonly label: string;
  readonly shown: ReactNode;
  readonly testId?: string;
  readonly down?: boolean;
  readonly wide?: boolean;
};

export function CompactSelect({ label, shown, title, testId, down = false, wide = false, children, ...props }: CompactSelectProps) {
  return (
    <span className={cn("bare-control text-ui font-medium", wide ? "max-w-44" : "max-w-32")} data-testid={testId} title={title}>
      {down && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" data-testid="picker-down" />}
      <span className="flex min-w-0 items-baseline gap-1.5 truncate">{shown}</span>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      <select
        aria-label={label}
        className="absolute top-1/2 left-1/2 h-[max(100%,2.5rem)] w-[max(calc(100%+0.75rem),2.5rem)] -translate-1/2 cursor-pointer opacity-0"
        {...props}
      >
        {children}
      </select>
    </span>
  );
}

// The model picker: the engines of the master's chain, `model` the one this client's next messages
// are for. It is this client's own (kept in localStorage): a change sends nothing, and a turn
// waiting for a model is resumed from its alert, not from here. An engine that hit a usage limit
// is disabled with why, unless it is the one picked, which then shows a small down mark.
export function ModelPicker({ model, onModel, state }: { readonly model: string; readonly onModel: (ref: string) => void; readonly state: SessionState }) {
  const current = state.engines.find((e) => e.ref === model);
  // the name, then the effort when the server's label names one
  const { name, effort } = labelParts(current?.label ?? model);
  return (
    <CompactSelect
      wide
      down={current !== undefined && current.down !== null}
      label="Model"
      onChange={(e) => {
        onModel(e.currentTarget.value);
      }}
      shown={
        <>
          <span className="truncate">{name}</span>
          {effort !== null && <span className="shrink-0">{effort}</span>}
        </>
      }
      testId="model-picker"
      title={current ? `${current.label}: your next messages${current.down === null ? "" : ` (unavailable: ${current.down})`}` : undefined}
      value={model}
    >
      {state.engines.map((e) => (
        <option disabled={e.down !== null && e.ref !== model} key={e.ref} value={e.ref}>
          {e.down === null ? e.label : `${e.label}: unavailable, ${e.down}`}
        </option>
      ))}
    </CompactSelect>
  );
}
