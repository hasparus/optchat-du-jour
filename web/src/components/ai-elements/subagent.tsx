// AI Elements' Subagent, built on shadcn/ui's Trace, Code Block (through our Tool) and Badge as
// the October 2026 pattern does it (ui.shadcn.com/docs/ai-elements/radix/subagent): one line for
// a run, "Running scout" while it works and "Ran scout" once it reported, that opens into the task
// it was given, where it runs, its steps (tool lines) and its report.
//
// Presentational only, and wired to nothing yet: SPEC M7 (subagents) isn't built. The props are
// what M7 is to tell, after docs/optchat.md §5–§6 and the earlier gist's spawn and tell: a
// subagent has a name (its reports reach the chat as a `user` message starting "[name] ", E23, and
// `zoom("name")` opens its own log), the task it was spawned with, a status, the device it runs
// on, its steps from its own log, and its final reply. Tell (a message to it, between its tool
// calls) and Stop are the caller's callbacks. Background work (chat/background-work.tsx) has the
// slot; only the story page (web/stories.html) and the tests fill it until the server reports
// subagents.
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { toolStateOf, toolSummary } from "@/lib/rows";
import { cn } from "@/lib/utils";
import { ArrowUpIcon, BotIcon, CircleCheckIcon, CircleSlashIcon, CircleXIcon, type LucideIcon, SquareIcon } from "lucide-react";
import { type ComponentProps, useId, useState } from "react";

export type SubagentStatus = "running" | "finished" | "failed" | "stopped";

// one step from the subagent's own log: a tool entry and the echo answering it, as a chat tool row
export type SubagentStep = {
  readonly key: string;
  readonly name: string;
  readonly args: string;
  readonly output: string | null;
  // the echo is flagged failed (E28)
  readonly failed: boolean;
};

export type SubagentRun = {
  // what reports and zoom name it by: "[scout] …", zoom("scout")
  readonly name: string;
  // the task it was spawned with, as the master wrote it
  readonly task: string;
  readonly status: SubagentStatus;
  // the device its calls run on
  readonly device: string;
  // the engine's label (engineLabel), when the server names one
  readonly engine?: string | null | undefined;
  // how long it has run, or ran: "1 min 05 s" (background-work.tsx elapsed)
  readonly elapsed?: string | null | undefined;
  readonly steps: readonly SubagentStep[];
  // its final reply, which reaches the chat as its report; null until it has one
  readonly report: string | null;
  // why it failed or was stopped, when the server says
  readonly reason?: string | null | undefined;
};

export type SubagentProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange" | "children"> & {
  readonly run: SubagentRun;
  // a message to the running subagent, read between its tool calls
  readonly onTell?: ((name: string, text: string) => void) | undefined;
  readonly onStop?: ((name: string) => void) | undefined;
};

const TITLES = {
  failed: (n: string) => `Failed to run ${n}`,
  finished: (n: string) => `Ran ${n}`,
  running: (n: string) => `Running ${n}`,
  stopped: (n: string) => `Stopped ${n}`,
} satisfies Record<SubagentStatus, (name: string) => string>;

const ICONS = { failed: CircleXIcon, finished: CircleCheckIcon, running: BotIcon, stopped: CircleSlashIcon } satisfies Record<SubagentStatus, LucideIcon>;

// a running run is open, the others closed, until the reader chooses
export const Subagent = ({ className, run, onTell, onStop, ...props }: SubagentProps) => {
  const running = run.status === "running";
  const Icon = ICONS[run.status];
  const lastStep = run.steps.at(-1)?.key;
  return (
    <Trace className="group/subagent">
      <TraceCollapsible className={className} data-slot="subagent" data-status={run.status} defaultOpen={running} {...props}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <TraceCollapsibleTrigger className="min-h-7 min-w-0 flex-1 text-ui pointer-coarse:min-h-10">
            <TraceLine className="text-ui" status={running ? "running" : run.status === "failed" ? "error" : undefined}>
              <TraceIcon>
                <Icon className="size-3.5" strokeWidth={1.75} />
              </TraceIcon>
              <TraceTitle className="font-medium text-foreground/85 in-data-[status=error]:text-destructive">{TITLES[run.status](run.name)}</TraceTitle>
              {run.elapsed !== null && run.elapsed !== undefined && <TraceDescription className="text-xs text-muted-foreground">{run.elapsed}</TraceDescription>}
            </TraceLine>
          </TraceCollapsibleTrigger>
          {/* a button can't sit inside a trigger (the pattern's PlanAction): Stop is beside it */}
          {running && onStop !== undefined && (
            <Button
              aria-label={`Stop ${run.name}`}
              className="shrink-0 rounded-full bg-soft text-foreground hover:bg-soft-strong"
              onClick={() => {
                onStop(run.name);
              }}
              size="icon-sm"
              title={`Stop ${run.name}`}
              variant="ghost"
            >
              <SquareIcon className="size-3 fill-current" strokeWidth={0} />
            </Button>
          )}
        </div>
        <TraceCollapsibleContent className="flex flex-col gap-3 text-foreground">
          <div className="flex flex-wrap gap-1.5" data-slot="subagent-badges">
            <Badge className="text-muted-foreground" variant="outline">
              on {run.device}
            </Badge>
            {run.engine !== null && run.engine !== undefined && <Badge variant="secondary">{run.engine}</Badge>}
          </div>
          <p className="text-ui whitespace-pre-wrap" data-slot="subagent-task">
            {run.task}
          </p>
          {run.steps.length > 0 && (
            <Trace className="gap-0.5" data-slot="subagent-steps">
              {run.steps.map((step) => {
                const state = toolStateOf(step, running, step.key === lastStep);
                return (
                  <Tool key={step.key}>
                    <ToolHeader detail={toolSummary(step.args)} name={step.name} state={state} />
                    <ToolContent>
                      {step.args !== "" && <ToolInput input={step.args} />}
                      {step.output !== null && <ToolOutput failed={state === "error"} output={step.output} />}
                    </ToolContent>
                  </Tool>
                );
              })}
            </Trace>
          )}
          {run.report !== null && (
            <div className="flex flex-col gap-1" data-slot="subagent-report">
              <span className="text-2xs text-muted-foreground">Report</span>
              <p className="text-ui whitespace-pre-wrap">{run.report}</p>
            </div>
          )}
          {run.reason !== null && run.reason !== undefined && (
            <p className={cn("text-xs", run.status === "failed" ? "text-destructive" : "text-muted-foreground")} data-slot="subagent-reason">
              {run.reason}
            </p>
          )}
          {running && onTell !== undefined && <TellSubagent name={run.name} onTell={onTell} />}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};

// a line to tell the running subagent something; sent on Enter or the arrow, then cleared
function TellSubagent({ name, onTell }: { readonly name: string; readonly onTell: (name: string, text: string) => void }) {
  const [text, setText] = useState("");
  const id = useId();
  const send = () => {
    if (text.trim() === "") return;
    onTell(name, text);
    setText("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label className="sr-only" htmlFor={id}>
        Tell {name}
      </label>
      <InputGroup className="h-9 rounded-full pointer-coarse:h-10">
        <InputGroupInput
          className="text-ui pointer-coarse:text-base"
          id={id}
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          placeholder={`Tell ${name}…`}
          value={text}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label={`Send to ${name}`} className="rounded-full" disabled={text.trim() === ""} size="icon-sm" type="submit" variant="default">
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
