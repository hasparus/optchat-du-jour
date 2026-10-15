// The story page (web/stories.html): UI that the app has no data for yet, in each of its states,
// for a look and for the e2e (e2e/stories.spec.ts). Vite serves it in dev; the build takes only
// index.html, so it never ships. Today: AI Elements' Subagent (SPEC M7, not built), alone and in
// the Background work sheet's `extra` slot as M7 would fill it, over the scripted server the unit
// tests use (test/fixture.ts).
import { BackgroundWork, Group } from "@/chat/background-work";
import { Subagent } from "@/components/ai-elements/subagent";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openLink } from "@/lib/connection";
import { makeSession } from "@/lib/session";
import { fakeServer, IDLE, snapshot } from "@/test/fixture";
import { EventType } from "@ag-ui/core";
import { NetworkIcon } from "lucide-react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { RUNS } from "./subagent-runs";

const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
const link = openLink("ws://stories.invalid/ws", { retryMs: 1, socket: server.socket });
const session = makeSession(link);
const devices = {
  data: [],
  error: null,
  reload: () => {
    // no devices in a story
  },
};

function Stories() {
  const [said, setSaid] = useState<readonly string[]>([]);
  const [open, setOpen] = useState(false);
  const tell = (name: string, text: string) => {
    setSaid((s) => [...s, `tell ${name}: ${text}`]);
  };
  const stop = (name: string) => {
    setSaid((s) => [...s, `stop ${name}`]);
  };
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-184 flex-col gap-6 px-4 py-6">
        <h1 className="text-base font-semibold">Subagent (SPEC M7, wired to nothing)</h1>
        {RUNS.map((run) => (
          <section className="flex flex-col gap-2" data-testid={`story-${run.status}`} key={run.name}>
            <h2 className="text-2xs text-muted-foreground">{run.status}</h2>
            <Subagent defaultOpen onStop={stop} onTell={tell} run={run} />
          </section>
        ))}
        <Button
          className="self-start"
          onClick={() => {
            setOpen(true);
          }}
          size="sm"
          variant="outline"
        >
          Background work with subagents
        </Button>
        <BackgroundWork
          devices={devices}
          extra={
            <Group count={RUNS.length} icon={<NetworkIcon className="size-3.5" />} title="Subagents">
              {RUNS.map((run) => (
                <div data-testid="work-subagent" key={run.name} role="listitem">
                  <Subagent onStop={stop} onTell={tell} run={run} />
                </div>
              ))}
            </Group>
          }
          link={link}
          onOpenChange={setOpen}
          open={open}
          session={session}
        />
        <ol className="font-mono text-xs" data-testid="story-calls">
          {said.map((s, k) => (
            // oxlint-disable-next-line react/no-array-index-key -- a call is its place in the list
            <li key={k}>{s}</li>
          ))}
        </ol>
      </main>
    </TooltipProvider>
  );
}

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Stories />
    </StrictMode>,
  );
}
