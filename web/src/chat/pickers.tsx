// The composer's pickers (SPEC "Web UI", Composer): the follow-up setting, the model, and the
// compact native select the device picker is, and the model picker on a touch screen. With a mouse
// the model picker is AI Elements' Model Selector (a Dropdown Menu).
import { useCoarsePointer } from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Link } from "@/lib/connection";
import { cn } from "@/lib/utils";
import { engineParts, type FollowUp, type MasterEngine, type SessionState } from "@wire";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode } from "react";

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
      <PopoverContent align="start" className="w-72 gap-3 rounded-xl p-3 text-ui shadow-float ring-0">
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
// is disabled with why, unless it is the one picked, which then shows a small down mark. On a touch
// screen it is the phone's own picker (SPEC "Web UI"); with a mouse, the Model Selector.
// `label` names what is picked for ("Model" for the composer's next messages); `shown`, what the
// closed picker says when the model is none of the chain's own entries (a subagent's at another
// effort, SPEC M7a); `testId`, the picker's
type PickerProps = {
  readonly model: string;
  readonly onModel: (ref: string) => void;
  readonly state: SessionState;
  readonly label?: string;
  readonly shown?: string;
  readonly testId?: string;
  readonly purpose?: string; // what the picked model is for, in its title
};
export function ModelPicker(props: PickerProps) {
  return useCoarsePointer() ? <NativeModelPicker {...props} /> : <ModelSelector {...props} />;
}

// the closed picker: the name, then the effort when the server's label names one
function ModelShown({ label }: { readonly label: string }) {
  const { name, effort } = labelParts(label);
  return (
    <>
      <span className="truncate">{name}</span>
      {effort !== null && <span className="shrink-0">{effort}</span>}
    </>
  );
}

const pickerTitle = (current: MasterEngine | undefined, purpose = "your next messages") => (current ? `${current.label}: ${purpose}${current.down === null ? "" : ` (unavailable: ${current.down})`}` : undefined);

// the engines in the chain's order, grouped where they run (Claude Code, the ChatGPT plan, a key),
// read from each ref (wire.ts engineParts), not from its label. (A loop: Map.groupBy is newer than
// the Safari versions the app runs on.)
const byWhere = (engines: readonly MasterEngine[]) => {
  const groups = new Map<string, MasterEngine[]>();
  for (const e of engines) {
    const { where } = engineParts(e.ref);
    groups.set(where, [...(groups.get(where) ?? []), e]);
  }
  return groups;
};

// AI Elements' Model Selector (ui.shadcn.com/docs/ai-elements/radix/model-selector): a Dropdown
// Menu of radio items, a group per provider. Its trigger is the bare label the footer's other
// controls are (bare-control). No second menu for the effort: an effort is part of a chain entry
// (`claude-code:opus@xhigh` is an engine of its own), so each item names its own. A down engine is
// disabled and says why in muted text, which stays AA (the registry's 50% opacity would not).
function ModelSelector({ model, onModel, state, label = "Model", shown, testId = "model-picker", purpose }: PickerProps) {
  const current = state.engines.find((e) => e.ref === model);
  const down = current !== undefined && current.down !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label={`${label}: ${current?.label ?? shown ?? model}`} className="bare-control max-w-44 cursor-pointer text-ui font-medium" data-testid={testId} title={pickerTitle(current, purpose)} type="button">
          {down && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" data-testid="picker-down" />}
          <span className="flex min-w-0 items-baseline gap-1.5 truncate">
            <ModelShown label={current?.label ?? shown ?? model} />
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto max-w-80 min-w-56 rounded-xl p-1.5 text-ui shadow-float ring-0" data-testid="model-menu" side="top" sideOffset={8}>
        <DropdownMenuRadioGroup
          onValueChange={(ref) => {
            onModel(ref);
          }}
          value={model}
        >
          {[...byWhere(state.engines)].map(([provider, engines], k) => (
            <Fragment key={provider}>
              {k > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-2xs">{provider}</DropdownMenuLabel>
                {engines.map((e) => (
                  <DropdownMenuRadioItem
                    className="min-h-8 rounded-lg text-ui data-disabled:text-muted-foreground data-disabled:opacity-100"
                    disabled={e.down !== null && e.ref !== model}
                    key={e.ref}
                    value={e.ref}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-baseline gap-1.5" data-slot="model-shown">
                        <ModelShown label={e.label} />
                      </span>
                      {e.down !== null && <span className="text-xs text-muted-foreground">unavailable: {e.down}</span>}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NativeModelPicker({ model, onModel, state, label = "Model", shown, testId = "model-picker", purpose }: PickerProps) {
  const current = state.engines.find((e) => e.ref === model);
  return (
    <CompactSelect
      wide
      down={current !== undefined && current.down !== null}
      label={label}
      onChange={(e) => {
        onModel(e.currentTarget.value);
      }}
      shown={<ModelShown label={current?.label ?? shown ?? model} />}
      testId={testId}
      title={pickerTitle(current, purpose)}
      value={model}
    >
      {current === undefined && <option value={model}>{shown ?? model}</option>}
      {state.engines.map((e) => (
        <option disabled={e.down !== null && e.ref !== model} key={e.ref} value={e.ref}>
          {e.down === null ? e.label : `${e.label}: unavailable, ${e.down}`}
        </option>
      ))}
    </CompactSelect>
  );
}
