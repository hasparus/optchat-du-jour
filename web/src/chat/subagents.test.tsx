// The subagents' cards in Background work (SPEC M7a): one per subagent the state lists, each with
// its state, time, model and side log (read from /api/subagent, only the new entries as it grows),
// and its Stop, Tell and model frames; and the header's busy mark while one runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openLink } from "@/lib/connection";
import { makeSession } from "@/lib/session";
import { fakeServer, IDLE, parseSent, snapshot, state } from "@/test/fixture";
import type { Msg, SubagentInfo } from "@wire";
import { BackgroundWork, busyWith } from "./background-work";
import { runOf, stepsOf, Subagents } from "./subagents";

const links: { readonly close: () => void }[] = [];
const realFetch = globalThis.fetch;
// what /api/subagent answers: each subagent's side log, and which entries each read asked from
const LOGS = new Map<string, Msg[]>();
const reads: string[] = [];
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input, "http://127.0.0.1:7700/");
      if (url.pathname !== "/api/subagent") return new Response(null, { status: 404 });
      const name = url.searchParams.get("name") ?? "";
      const from = Number(url.searchParams.get("from") ?? "0");
      reads.push(`${name}@${from}`);
      const entries = LOGS.get(name);
      if (!entries) return new Response(null, { status: 404 });
      const info = SCOUT.name === name ? SCOUT : NOTES;
      return Response.json({ entries: entries.slice(from), subagent: info });
    },
    { preconnect: realFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const l of links.splice(0)) l.close();
  globalThis.fetch = realFetch;
  LOGS.clear();
  reads.length = 0;
});

const entry = (i: number, kind: Msg["kind"], text: string): Msg => ({ date: "2026-10-16T10:00:00Z", i, kind, text });
// an echo the log flags as failed (E28)
const failed = (i: number, text: string): Msg => ({ date: "2026-10-16T10:00:00Z", error: true, i, kind: "echo", text });

// fake data only: made-up names, tasks and paths
const SCOUT: SubagentInfo = {
  device: "mini",
  effort: "high",
  elapsed: 65_000,
  entries: 3,
  label: "Claude Opus (Claude Code)",
  lastLine: 'tool: Read {"file_path":"~/demo/notes.md"}',
  name: "scout",
  ref: "claude-code:opus",
  started: "2026-10-16T10:00:00Z",
  state: "running",
  task: "Find the trip dates in the demo notes.",
};
const NOTES: SubagentInfo = {
  device: "mini",
  effort: "low",
  elapsed: 48_000,
  entries: 4,
  label: "Claude Opus (Claude Code, low)",
  name: "notes",
  ref: "claude-code:opus@low",
  started: "2026-10-16T09:58:00Z",
  state: "done",
  task: "Which notes mention the trip?",
};

const sheet = (subagents: readonly SubagentInfo[]) => {
  const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, subagents }, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  links.push(link);
  const session = makeSession(link);
  render(
    <TooltipProvider>
      <BackgroundWork
        devices={{
          data: [],
          error: null,
          reload: () => {
            // no devices in this test
          },
        }}
        extra={[<Subagents key="subagents" link={link} session={session} />]}
        link={link}
        onOpenChange={() => {
          // the sheet stays open in the test
        }}
        open
        session={session}
      />
    </TooltipProvider>,
  );
  return { server, session };
};

test("a card per subagent: running first with Stop, its time, model, task and steps from its side log; a done one with its report", async () => {
  LOGS.set("scout", [entry(0, "user", SCOUT.task), entry(1, "tool", 'Grep {"pattern":"trip"}'), entry(2, "echo", "notes.md:3: trip Oct 3")]);
  LOGS.set("notes", [entry(0, "user", NOTES.task), entry(1, "tool", 'Bash {"command":"ls"}'), failed(2, "Claude requested permissions to use Bash"), entry(3, "talk", "Two notes; the newest has the dates.")]);
  const { server } = sheet([SCOUT, NOTES]);
  const dialog = await screen.findByRole("dialog", { name: "Background work" });
  const group = await within(dialog).findByText("Subagents");
  expect(group).toBeTruthy();
  const scout = await within(dialog).findByTestId("subagent-scout");
  expect(within(scout).getByText("Running scout")).toBeTruthy();
  expect(within(scout).getByText("1 min 05 s")).toBeTruthy();
  expect(within(scout).getByText(SCOUT.task)).toBeTruthy();
  expect(within(scout).getByTestId("subagent-model-scout").textContent).toContain("Opus");
  await waitFor(() => {
    expect(within(scout).getByText("Grep")).toBeTruthy();
  });
  // Stop and Tell go to the server as the card's frames
  fireEvent.click(within(scout).getByRole("button", { name: "Stop scout" }));
  const box = within(scout).getByLabelText("Tell scout");
  fireEvent.change(box, { target: { value: "look in ~/demo/old too" } });
  fireEvent.click(within(scout).getByRole("button", { name: "Send to scout" }));
  const frames = server.sent.map((f) => parseSent(f));
  expect(frames).toContainEqual({ name: "scout", type: "stop-subagent" });
  expect(frames).toContainEqual({ name: "scout", text: "look in ~/demo/old too", type: "tell" });
  // the done one: closed, its title, and once opened its report and its refused Bash
  const notes = within(dialog).getByTestId("subagent-notes");
  expect(within(notes).getByText("Ran notes")).toBeTruthy();
  expect(within(notes).queryByRole("button", { name: "Stop notes" })).toBeNull();
  fireEvent.click(within(notes).getByText("Ran notes"));
  await waitFor(() => {
    expect(within(notes).getByText("Two notes; the newest has the dates.")).toBeTruthy();
  });
  // a message to one that has ended starts it again
  expect(within(notes).getByPlaceholderText("Tell notes to go on…")).toBeTruthy();
});

test("its side log is read as it grows, only the entries this page lacks", async () => {
  LOGS.set("scout", [entry(0, "user", SCOUT.task), entry(1, "tool", 'Grep {"pattern":"trip"}'), entry(2, "echo", "notes.md:3")]);
  const { server } = sheet([SCOUT]);
  await waitFor(() => {
    expect(reads).toEqual(["scout@0"]);
  });
  LOGS.get("scout")?.push(entry(3, "tool", 'Read {"file_path":"~/demo/notes.md"}'));
  act(() => {
    server.play(state({ subagents: [{ ...SCOUT, entries: 4 }] }));
  });
  await waitFor(() => {
    expect(reads).toEqual(["scout@0", "scout@3"]);
  });
  const scout = screen.getByTestId("subagent-scout");
  await waitFor(() => {
    expect(within(scout).getByText("Read")).toBeTruthy();
  });
});

test("a model picked on a card goes to the server for that subagent's next call", async () => {
  LOGS.set("scout", []);
  const { server } = sheet([{ ...SCOUT, entries: 0 }]);
  const picker = await screen.findByTestId("subagent-model-scout");
  fireEvent.pointerDown(picker, { button: 0, pointerType: "mouse" });
  fireEvent.click(picker);
  const item = await screen.findByRole("menuitemradio", { name: /Sol/ });
  fireEvent.click(item);
  await waitFor(() => {
    expect(server.sent.map((f) => parseSent(f))).toContainEqual({ model: "openai-plan:gpt-6.1-sol", name: "scout", type: "subagent-model" });
  });
});

test("steps pair each tool line with its echo; the run says what the card shows", () => {
  const entries = [entry(0, "user", "t"), entry(1, "tool", 'Read {"file_path":"a"}'), entry(2, "echo", "x"), entry(3, "tool", "Glob"), entry(4, "talk", "done")];
  expect(stepsOf(entries)).toEqual([
    { args: '{"file_path":"a"}', failed: false, key: "s1", name: "Read", output: "x" },
    { args: "", failed: false, key: "s3", name: "Glob", output: null },
  ]);
  expect(runOf({ ...NOTES, why: "stopped by the user", state: "stopped" }, entries, 3000)).toMatchObject({ elapsed: "3 s", reason: "stopped by the user", report: null, status: "stopped" });
  expect(runOf(NOTES, entries, 48_000)).toMatchObject({ engine: "Claude Opus (Claude Code, low)", report: "done", status: "finished" });
});

test("the header's mark counts a running subagent as busy", async () => {
  const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, subagents: [SCOUT, NOTES] }, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  links.push(link);
  const session = makeSession(link);
  await waitFor(() => {
    expect(session.get().state?.subagents?.length).toBe(2);
  });
  expect(busyWith(session.get())).toBe(1);
});
