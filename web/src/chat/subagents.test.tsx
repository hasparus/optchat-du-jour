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
import { diffstat, mergeText } from "@/components/ai-elements/subagent";
import { retryAfter, runOf, stepsOf, Subagents } from "./subagents";

const links: { readonly close: () => void }[] = [];
const realFetch = globalThis.fetch;
// what /api/subagent answers: each subagent's side log, and which entries each read asked from;
// `hold`, when set, is what each answer waits for first
const LOGS = new Map<string, Msg[]>();
const reads: string[] = [];
let hold: Promise<boolean> | null = null;
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input, "http://127.0.0.1:7700/");
      if (url.pathname !== "/api/subagent") return new Response(null, { status: 404 });
      const name = url.searchParams.get("name") ?? "";
      const from = Number(url.searchParams.get("from") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      reads.push(`${name}@${from}`);
      if (hold) await hold;
      const entries = LOGS.get(name);
      if (!entries) return new Response(null, { status: 404 });
      const info = SCOUT.name === name ? SCOUT : NOTES;
      return Response.json({ entries: entries.slice(from, from + limit), subagent: info });
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
  hold = null;
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

test("a read on its way when more entries are counted is kept, and the next one starts where it ends", async () => {
  LOGS.set("scout", [entry(0, "user", SCOUT.task), entry(1, "tool", 'Grep {"pattern":"trip"}'), entry(2, "echo", "notes.md:3")]);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  hold = promise;
  const { server } = sheet([SCOUT]);
  await waitFor(() => {
    expect(reads).toEqual(["scout@0"]);
  });
  // two more entries counted while the first read is on its way: no second read yet
  LOGS.get("scout")?.push(entry(3, "tool", 'Read {"file_path":"~/demo/notes.md"}'), entry(4, "echo", "trip: Oct 3"));
  act(() => {
    server.play(state({ subagents: [{ ...SCOUT, entries: 4 }] }));
  });
  act(() => {
    server.play(state({ subagents: [{ ...SCOUT, entries: 5 }] }));
  });
  await new Promise((r) => {
    setTimeout(r, 30);
  });
  expect(reads).toEqual(["scout@0"]);
  hold = null;
  resolve(true);
  const scout = await screen.findByTestId("subagent-scout");
  await waitFor(() => {
    expect(within(scout).getByText("Read")).toBeTruthy();
  });
  expect(reads[0]).toBe("scout@0");
  expect(reads.length).toBeLessThanOrEqual(2); // the first read's answer kept, then one for the rest
});

test("a long side log is read a page at a time", async () => {
  const many = Array.from({ length: 120 }, (_, i) => (i === 0 ? entry(0, "user", SCOUT.task) : entry(i, i % 2 === 1 ? "tool" : "echo", i % 2 === 1 ? `Grep {"pattern":"p${i}"}` : `hit ${i}`)));
  LOGS.set("scout", many);
  sheet([{ ...SCOUT, entries: 120 }]);
  await waitFor(() => {
    expect(reads).toEqual(["scout@0", "scout@50", "scout@100"]);
  });
});

test("while the link is down a card's Stop, Tell and model can't be used", async () => {
  LOGS.set("scout", []);
  const { server } = sheet([{ ...SCOUT, entries: 0 }]);
  const scout = await screen.findByTestId("subagent-scout");
  expect(within(scout).getByRole("button", { name: "Stop scout" })).toHaveProperty("disabled", false);
  act(() => {
    server.drop();
  });
  await waitFor(() => {
    expect(within(scout).getByRole("button", { name: "Stop scout" })).toHaveProperty("disabled", true);
  });
  expect(within(scout).getByTestId("subagent-model-scout")).toHaveProperty("disabled", true);
  fireEvent.change(within(scout).getByLabelText("Tell scout"), { target: { value: "hello" } });
  expect(within(scout).getByRole("button", { name: "Send to scout" })).toHaveProperty("disabled", true);
});

test("a side log read that keeps failing waits before it is tried again, longer each time", async () => {
  // no LOGS entry: /api/subagent answers 404, as a server that is down would fail the read
  const { server } = sheet([{ ...SCOUT, entries: 3 }]);
  await new Promise((r) => {
    setTimeout(r, 300);
  });
  expect(reads).toEqual(["scout@0"]); // not tried again within the first second
  // a count that grows meanwhile doesn't cut the wait short
  act(() => {
    server.play(state({ subagents: [{ ...SCOUT, entries: 4 }] }));
  });
  await new Promise((r) => {
    setTimeout(r, 100);
  });
  expect(reads).toEqual(["scout@0"]);
  // after the wait it is read again, and once there is something it shows
  LOGS.set("scout", [entry(0, "user", SCOUT.task), entry(1, "tool", 'Grep {"pattern":"trip"}'), entry(2, "echo", "x"), entry(3, "talk", "on it")]);
  await waitFor(
    () => {
      expect(reads).toEqual(["scout@0", "scout@0"]);
    },
    { timeout: 2000 },
  );
  expect([1, 2, 3, 4, 5, 6, 9].map(retryAfter)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
});

// M7b (SPEC "Subagents"): where each works, an isolated one's branch and how it went back, who
// spawned it, and Stop all. Fake data only.
const ISOLATED: SubagentInfo = {
  ...NOTES,
  folder: "~/demo/repo",
  isolated: true,
  merge: { deletions: 2, detail: "main fast-forwarded to optchat/fixer; its worktree and branch are removed", files: 3, insertions: 40, into: "main", outcome: "fast-forward" },
  name: "fixer",
  task: "Fix the failing test in the demo repo.",
};
const CONFLICTED: SubagentInfo = {
  ...ISOLATED,
  merge: { conflicts: ["src/a.ts", "README.md"], deletions: 1, detail: "optchat/clash conflicts with main", files: 2, insertions: 5, into: "main", outcome: "conflict" },
  name: "clash",
  worktree: { base: "0123456789abcdef0123456789abcdef01234567", branch: "optchat/clash", path: "/home/demo/.optchat-worktrees/clash", repo: "/home/demo/repo" },
};
const NESTED: SubagentInfo = { ...SCOUT, device: "macbook", folder: "~/repos/site", name: "helper", parent: "scout" };

test("a card shows where it works: its device and folder, its branch when isolated, how the branch went back, and who spawned it", async () => {
  for (const name of ["fixer", "clash", "helper"]) LOGS.set(name, []);
  sheet([NESTED, { ...ISOLATED, entries: 0 }, { ...CONFLICTED, entries: 0 }]);
  const dialog = await screen.findByRole("dialog", { name: "Background work" });
  const fixer = await within(dialog).findByTestId("subagent-fixer");
  fireEvent.click(within(fixer).getByText("Ran fixer"));
  await waitFor(() => {
    expect(within(fixer).getByText("optchat/fixer")).toBeTruthy();
  });
  expect(within(fixer).getByText("from ~/demo/repo")).toBeTruthy();
  expect(fixer.querySelector('[data-slot="subagent-merge"]')?.textContent).toBe("Merged into main (fast-forward): 3 files changed, +40 −2");
  const clash = within(dialog).getByTestId("subagent-clash");
  fireEvent.click(within(clash).getByText("Ran clash"));
  await waitFor(() => {
    expect(clash.querySelector('[data-slot="subagent-merge"]')?.textContent).toBe("Not merged: conflicts with main in src/a.ts, README.md. optchat/clash is kept: 2 files changed, +5 −1");
  });
  expect(clash.querySelector<HTMLElement>('[data-slot="subagent-merge"]')?.dataset.outcome).toBe("conflict");
  // nested, on the other machine, working directly in its folder: no branch, no merge
  const helper = within(dialog).getByTestId("subagent-helper");
  expect(within(helper).getByText("on macbook")).toBeTruthy();
  expect(within(helper).getByText("in ~/repos/site")).toBeTruthy();
  expect(within(helper).getByText("spawned by scout")).toBeTruthy();
  expect(helper.querySelector('[data-slot="subagent-branch"]')).toBeNull();
  expect(helper.querySelector('[data-slot="subagent-merge"]')).toBeNull();
});

test("the run says the branch, the merge and the parent; an isolated one keeps its branch name once merged", () => {
  expect(runOf(ISOLATED, [], 1000)).toMatchObject({ branch: "optchat/fixer", folder: "~/demo/repo", isolated: true, merge: { files: 3, outcome: "fast-forward" }, parent: null });
  expect(runOf(CONFLICTED, [], 1000)).toMatchObject({ branch: "optchat/clash", merge: { outcome: "conflict" } });
  expect(runOf(NESTED, [], 1000)).toMatchObject({ branch: null, device: "macbook", isolated: false, merge: null, parent: "scout" });
  expect(mergeText({ deletions: 0, detail: "d", files: 1, insertions: 1, into: "main", outcome: "merged" }, "optchat/x")).toBe("Merged into main: 1 file changed, +1 −0");
  expect(mergeText({ deletions: 0, detail: "the folder is on no branch", files: 1, insertions: 1, into: null, outcome: "not-merged" }, "optchat/x")).toBe("Not merged: the folder is on no branch");
  expect(diffstat({ deletions: 2, files: 3, insertions: 40 })).toBe("3 files changed, +40 −2");
});

test("Stop all, while a subagent runs, sends one frame for the turn and every subagent", async () => {
  LOGS.set("scout", []);
  LOGS.set("notes", []);
  const { server } = sheet([{ ...SCOUT, entries: 0 }, NOTES]);
  const stop = await screen.findByTestId("stop-all");
  expect(stop.getAttribute("aria-label")).toBe("Stop all: 1 subagent");
  fireEvent.click(stop);
  await waitFor(() => {
    expect(server.sent.map((f) => parseSent(f))).toContainEqual({ type: "stop-all" });
  });
});

test("with nothing running there is no Stop all", async () => {
  LOGS.set("notes", []);
  sheet([NOTES]);
  await screen.findByTestId("subagent-notes");
  expect(screen.queryByTestId("stop-all")).toBeNull();
});

test("when reports no longer wake the master, the group says so until the next message", async () => {
  LOGS.set("notes", []);
  const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, subagents: [NOTES], wakePaused: 8 }, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  links.push(link);
  const session = makeSession(link);
  render(
    <TooltipProvider>
      <Subagents link={link} session={session} />
    </TooltipProvider>,
  );
  const notice = await screen.findByTestId("wake-paused");
  expect(notice.textContent).toBe("Waking paused after 8 turns: reports wait for your next message.");
});
