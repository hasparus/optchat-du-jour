// Subagents in Background work (SPEC M7a, DESIGN.md "Background work"): a group of AI Elements'
// Subagent cards, one per subagent the server lists in its state (`subagents`: every running one,
// then the newest others). Each card says how it went and for how long, its model as a picker for
// its next call (the Model Selector, as the composer's), its task, its steps and its report from
// its own side log (read from /api/subagent as its `entries` grow, only the new ones), a Stop while
// it runs, and a Tell line: to a running one, read between its tool calls; to one that has ended,
// the message that starts it again. What the server refuses comes back as an info in the chat.
import { Subagent, type SubagentRun, type SubagentStatus, type SubagentStep } from "@/components/ai-elements/subagent";
import { api } from "@/lib/api";
import type { Link } from "@/lib/connection";
import type { SessionStore } from "@/lib/session";
import { type Msg, type SessionState, splitTool, type SubagentInfo } from "@wire";
import { NetworkIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { elapsed, Group, useNow } from "./background-work";
import { ModelPicker } from "./pickers";

const STATUS = { done: "finished", failed: "failed", running: "running", stopped: "stopped" } satisfies Record<SubagentInfo["state"], SubagentStatus>;

// a side log's tool lines, each with the echo after it (a step still running has none yet)
export const stepsOf = (entries: readonly Msg[]): SubagentStep[] => {
  const steps: SubagentStep[] = [];
  for (const [k, e] of entries.entries()) {
    if (e.kind !== "tool") continue;
    const { args, name } = splitTool(e.text);
    const next = entries[k + 1];
    const echo = next?.kind === "echo" ? next : null;
    steps.push({ args, failed: echo?.error === true, key: `s${e.i}`, name, output: echo?.text ?? null });
  }
  return steps;
};

// what the card shows of a subagent: the server's summary, and what its side log says
export const runOf = (info: SubagentInfo, entries: readonly Msg[], shownElapsed: number): SubagentRun => ({
  device: info.device ?? "this server",
  elapsed: elapsed(shownElapsed),
  engine: info.label ?? info.ref,
  name: info.name,
  reason: info.why ?? null,
  report: info.state === "done" ? (entries.findLast((e) => e.kind === "talk")?.text ?? null) : null,
  resumable: true,
  status: STATUS[info.state],
  steps: stepsOf(entries),
  task: info.task,
});

// entries per read of a side log
export const SIDE_PAGE = 50;

// the wait before a failed read of a side log is tried again: 1 s, doubling, at most 30 s
const RETRY_FIRST = 1000;
const RETRY_MAX = 30_000;
export const retryAfter = (failures: number) => Math.min(RETRY_MAX, RETRY_FIRST * 2 ** Math.max(0, failures - 1));

// Its side log as this page has it: the entries read so far, and the next ones while the server
// counts more (`entries`), a page at a time. One read at a time: a count that grows while one is
// on its way doesn't drop it (it starts where this page's log ends, so it is right whatever came
// since), and when it lands the next one starts if there is more. A read that fails is tried again
// after a wait that doubles with each failure in a row (`retryAfter`), never sooner, whatever the
// count does meanwhile; a success starts the count of failures again. A read or a wait that ends
// after the card is gone does nothing. A card is keyed by its subagent's name, so the name never
// changes under it.
function useSideLog(name: string, count: number) {
  const [log, setLog] = useState<readonly Msg[]>([]);
  const [retries, setRetries] = useState(0); // waits ended: each lets the effect read again
  const reading = useRef(false);
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (waiting.current !== null) clearTimeout(waiting.current);
      waiting.current = null;
    };
  }, []);
  const have = log.length;
  useEffect(() => {
    if (have >= count || reading.current || waiting.current !== null) return;
    reading.current = true;
    const read = async () => {
      try {
        const page = await api.subagent(name, have, SIDE_PAGE);
        reading.current = false;
        failures.current = 0;
        if (mounted.current) setLog((before) => [...before, ...page.entries.filter((e) => e.i >= before.length)]);
      } catch {
        // offline, or the server restarted: wait, then try again
        reading.current = false;
        if (!mounted.current) return;
        failures.current += 1;
        waiting.current = setTimeout(() => {
          waiting.current = null;
          if (mounted.current) setRetries((n) => n + 1);
        }, retryAfter(failures.current));
      }
    };
    void read();
  }, [name, count, have, retries]);
  return log;
}

// what the controls say while the link to the server is down: a frame then would go nowhere
const OFFLINE = "Not connected to the server";

function SubagentCard({
  info,
  state,
  link,
  now,
  stateAt,
  online,
}: {
  readonly info: SubagentInfo;
  readonly state: SessionState;
  readonly link: Link;
  readonly now: number;
  readonly stateAt: number;
  readonly online: boolean;
}) {
  const log = useSideLog(info.name, info.entries ?? 0);
  const running = info.state === "running";
  const run = runOf(info, log, info.elapsed + (running ? Math.max(0, now - stateAt) : 0));
  return (
    <div data-testid={`subagent-${info.name}`} role="listitem">
      <Subagent
        model={
          <ModelPicker
            disabled={!online}
            label={`Model of ${info.name}`}
            model={info.ref}
            onModel={(model) => {
              link.subagent({ model, name: info.name, type: "subagent-model" });
            }}
            purpose={`${info.name}'s next call`}
            shown={info.label}
            state={state}
            testId={`subagent-model-${info.name}`}
          />
        }
        onStop={(name) => {
          link.subagent({ name, type: "stop-subagent" });
        }}
        onTell={(name, text) => {
          link.subagent({ name, text, type: "tell" });
        }}
        run={run}
        unavailable={online ? undefined : OFFLINE}
      />
    </div>
  );
}

// The group, or nothing while the server lists no subagent
export function Subagents({ session, link }: { readonly session: SessionStore; readonly link: Link }) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const list = s.state?.subagents ?? [];
  const now = useNow(list.some((a) => a.state === "running"));
  if (s.state === null || list.length === 0) return null;
  const { state } = s;
  return (
    <Group count={list.length} icon={<NetworkIcon className="size-3.5" />} title="Subagents">
      {list.map((info) => (
        <SubagentCard info={info} key={info.name} link={link} now={now} online={s.status === "open"} state={state} stateAt={s.stateAt} />
      ))}
    </Group>
  );
}
