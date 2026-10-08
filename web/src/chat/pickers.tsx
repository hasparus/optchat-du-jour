// The composer's pickers (SPEC "Web UI", Composer): the follow-up setting, the model, and the
// compact native select both the model and the device picker are.
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Link } from "@/lib/connection";
import { cn } from "@/lib/utils";
import type { FollowUp, SessionState } from "@wire";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ComponentProps } from "react";

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
        <InputGroupButton aria-label={`Follow-ups: ${followUp}`} size="xs" title="What a message sent while a turn runs does" variant="ghost">
          <SlidersHorizontalIcon className="hidden min-[400px]:block" />
          <span className="capitalize">{followUp}</span>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 text-sm">
        <p className="font-medium">A message sent while a turn runs</p>
        <div className="grid grid-cols-2 gap-1.5">
          {choices.map((c) => (
            <button
              aria-pressed={followUp === c.value}
              className={cn("rounded-md border px-2 py-1.5 text-left transition-colors", followUp === c.value ? "border-primary bg-primary/10" : "hover:bg-muted")}
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
        <p className="text-xs text-muted-foreground">Shared by every device. The other button next to send, or Ctrl/⌘+Enter, does the other for one message.</p>
      </PopoverContent>
    </Popover>
  );
}

// "Claude Opus (Claude Code)" → "Opus", "GPT-6.1 Sol (ChatGPT plan)" → "GPT-6.1 Sol", "Claude Opus
// (Claude Code, xhigh)" → "Opus · xhigh": what the closed picker shows on a phone's narrow footer,
// and a queued message names; the options say it all. An effort stays, or one model at two
// efforts would read the same.
export const shortLabel = (label: string) => {
  const [, name = label, effort] = /^(.*) \([^(),]*(?:, ([^(),]+))?\)$/.exec(label) ?? [];
  return `${name.replace(/^Claude /, "")}${effort === undefined ? "" : ` · ${effort}`}`;
};

// A native select (the phone's own picker) laid over a compact label, so a picker in the footer
// takes the width of its value, not of its longest option
// `down`: what is shown can't take a turn now: a small mark beside it (the title says why)
type CompactSelectProps = ComponentProps<"select"> & { readonly label: string; readonly shown: string; readonly testId?: string; readonly down?: boolean };

export function CompactSelect({ label, shown, title, testId, down = false, children, ...props }: CompactSelectProps) {
  return (
    <span
      className="relative flex h-6 max-w-28 min-w-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground has-[select:focus-visible]:ring-[3px] has-[select:focus-visible]:ring-ring/50"
      data-testid={testId}
      title={title}
    >
      {down && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" data-testid="picker-down" />}
      <span className="truncate">{shown}</span>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      <select aria-label={label} className="absolute inset-0 cursor-pointer opacity-0" {...props}>
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
  return (
    <CompactSelect
      down={current !== undefined && current.down !== null}
      label="Model"
      onChange={(e) => {
        onModel(e.currentTarget.value);
      }}
      shown={shortLabel(current?.label ?? model)}
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
