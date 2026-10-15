// AI Elements' Plan, built on shadcn/ui's Trace as the October 2026 pattern does it
// (ui.shadcn.com/docs/ai-elements/radix/plan): one line that says how far the plan has got ("2 of
// 4 done") and opens into its steps. Our plans are Claude Code's TodoWrite calls, read from the
// tool entry's input as logged (lib/rows.ts planOf), so a plan reads the same live and after a
// reload; each call is its own row, as the log has it. Under the steps, one closed line holds the
// call's input and output as logged (SPEC "Web UI": rendering never hides what the model wrote). Two changes from the
// pattern: a pending step is not dimmed (Trace's `pending` is 60% opacity, under AA on muted text),
// its hollow circle and a screen-reader word say it; and the line's states are the Tool line's
// (running while the call or its turn is live, Failed from the logged flag).
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { PlanStep } from "@/lib/rows";
import { cn } from "@/lib/utils";
import { CircleCheckIcon, CircleDotIcon, CircleIcon, CodeIcon, ListChecksIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type PlanProps = ComponentProps<typeof TraceCollapsible>;

// a Trace of one collapsible line; `data-slot="plan"` names it
export const Plan = ({ className, children, ...props }: PlanProps) => (
  <Trace className="group/plan">
    <TraceCollapsible className={className} data-slot="plan" {...props}>
      {children}
    </TraceCollapsible>
  </Trace>
);

export type PlanHeaderProps = Omit<ComponentProps<typeof TraceCollapsibleTrigger>, "children"> & {
  readonly steps: readonly PlanStep[];
  // the plan is the turn's newest and the turn goes on: the title shimmers
  readonly running: boolean;
  // the call's echo is flagged failed (E28)
  readonly failed: boolean;
};

const doneOf = (steps: readonly PlanStep[]) => steps.filter((s) => s.status === "completed").length;

// the line: Trace's 28 px row (40 px on touch), like a tool line
export const PlanHeader = ({ className, steps, running, failed, ...props }: PlanHeaderProps) => (
  <TraceCollapsibleTrigger className={cn("min-h-7 text-ui pointer-coarse:min-h-10", className)} {...props}>
    <TraceLine className="text-ui" status={failed ? "error" : running ? "running" : undefined}>
      <TraceIcon>
        <ListChecksIcon className="size-3.5" strokeWidth={1.75} />
      </TraceIcon>
      <TraceTitle>
        <span className="font-medium text-foreground/85 in-data-[status=error]:text-destructive">Plan</span>
      </TraceTitle>
      <TraceDescription className={cn("text-xs", failed ? "font-medium text-destructive" : "text-muted-foreground")} data-slot="plan-progress">
        {failed ? "Failed" : `${doneOf(steps)} of ${steps.length} done`}
      </TraceDescription>
    </TraceLine>
  </TraceCollapsibleTrigger>
);

export type PlanContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const PlanContent = ({ className, ...props }: PlanContentProps) => <TraceCollapsibleContent className={cn("flex flex-col gap-2", className)} {...props} />;

const STEP_WORDS = { completed: "done", in_progress: "in progress", pending: "pending" } satisfies Record<PlanStep["status"], string>;

export type PlanStepsProps = {
  readonly steps: readonly PlanStep[];
  // the turn is live: the step in progress shimmers and reads in its present tense (activeForm)
  readonly live: boolean;
};

export const PlanSteps = ({ steps, live }: PlanStepsProps) => (
  <Trace className="gap-1" data-slot="plan-steps">
    {steps.map((step, k) => {
      const now = live && step.status === "in_progress";
      return (
        // oxlint-disable-next-line react/no-array-index-key -- two steps may read alike; a step is its place in the list
        <TraceLine className="text-ui" data-step={step.status} key={k} status={now ? "running" : undefined}>
          <TraceIcon>{stepIcon(step.status)}</TraceIcon>
          <TraceTitle className={cn("whitespace-normal", step.status === "completed" ? "text-muted-foreground" : "text-foreground/85")}>
            {now && step.activeForm !== null ? step.activeForm : step.content}
          </TraceTitle>
          <span className="sr-only">({STEP_WORDS[step.status]})</span>
        </TraceLine>
      );
    })}
  </Trace>
);

const stepIcon = (status: PlanStep["status"]): ReactNode =>
  status === "completed" ? (
    <CircleCheckIcon className="size-3.5" strokeWidth={1.75} />
  ) : status === "in_progress" ? (
    <CircleDotIcon className="size-3.5" strokeWidth={1.75} />
  ) : (
    <CircleIcon className="size-3.5" strokeWidth={1.75} />
  );

export type PlanLoggedProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange">;

// the call as logged, one line more under the steps, closed: its input and output blocks
export const PlanLogged = ({ className, children, ...props }: PlanLoggedProps) => (
  <Trace>
    <TraceCollapsible className={className} data-slot="plan-logged" {...props}>
      <TraceCollapsibleTrigger className="min-h-7 text-ui pointer-coarse:min-h-10">
        <TraceLine className="text-ui">
          <TraceIcon>
            <CodeIcon className="size-3.5" strokeWidth={1.75} />
          </TraceIcon>
          <TraceTitle>Input and output</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">{children}</TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
);
