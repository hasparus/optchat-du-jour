// AI Elements' Plan and Sources in the chat (SPEC "Web UI", Chat): a TodoWrite call's row as its
// turn's plan, live only in the turn that runs now, and the links a turn's web tools used under its
// last reply.
import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { start, stubApi } from "../test/app";
import { state } from "../test/fixture";

stubApi();

test("a TodoWrite call reads as a plan and a turn's web links as its reply's sources; a plan's input stays one line away", async () => {
  const todos = { todos: [{ activeForm: "Searching", content: "Search", status: "completed" }, { activeForm: "Answering", content: "Answer", status: "in_progress" }, { content: "Check", status: "pending" }] };
  const links = [{ title: "Docs", url: "https://docs.example.com/a" }, { title: "Bad", url: "javascript:alert(1)" }];
  start([
    { kind: "user", text: "look it up" },
    { kind: "tool", text: `TodoWrite ${JSON.stringify(todos)}` },
    { kind: "echo", text: "Todos have been modified successfully." },
    { kind: "tool", text: 'WebSearch {"query":"q"}' },
    { kind: "echo", text: `Web search results for query: "q"\n\nLinks: ${JSON.stringify(links)}` },
    { kind: "tool", text: 'WebFetch {"url":"https://other.example.org/p","prompt":"p"}' },
    { kind: "echo", text: "page" },
    { kind: "talk", text: "Found it." },
  ]);
  await screen.findByText("Found it.");
  // the newest plan opens by itself; nothing runs, so no step reads in its present tense
  const plan = screen.getByText("1 of 3 done").closest<HTMLElement>('[data-slot="plan"]') ?? document.body;
  expect(plan.dataset.state).toBe("open");
  expect(within(plan).getByText("Answer")).toBeTruthy();
  expect(within(plan).queryByText("Answering")).toBeNull();
  expect([...plan.querySelectorAll<HTMLElement>("[data-step]")].map((s) => s.dataset.step)).toEqual(["completed", "in_progress", "pending"]);
  expect(within(plan).queryByText(/"activeForm"/)).toBeNull();
  fireEvent.click(within(plan).getByText("Input and output"));
  await waitFor(() => {
    expect(plan.textContent).toContain("Todos have been modified successfully.");
  });
  // the sources: under the reply, the javascript: link left out
  const reply = screen.getByText("Found it.").closest<HTMLElement>("[data-reply]") ?? document.body;
  fireEvent.click(within(reply).getByText("Used 2 sources"));
  const anchors = await within(reply).findAllByRole("link");
  expect(anchors.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
    ["https://docs.example.com/a", "_blank", "noreferrer"],
    ["https://other.example.org/p", "_blank", "noreferrer"],
  ]);
  expect(document.body.innerHTML).not.toContain("javascript:alert");
});

test("a live plan: its step in progress reads in its present tense and the line runs; a failed TodoWrite says Failed", async () => {
  const todos = { todos: [{ activeForm: "Searching", content: "Search", status: "in_progress" }] };
  const { play } = start([
    { kind: "user", text: "go" },
    { kind: "tool", text: `TodoWrite ${JSON.stringify(todos)}` },
    { kind: "echo", text: "ok" },
  ]);
  await screen.findByText("Search");
  // the turn that runs now started at entry 0, so its plan is live
  play({ runId: "0", threadId: "mini", type: EventType.RUN_STARTED }, state({ phase: "running" }));
  const step = await screen.findByText("Searching");
  expect(step.closest<HTMLElement>('[data-slot="trace-line"]')?.dataset.status).toBe("running");
  play({ runId: "0", threadId: "mini", type: EventType.RUN_FINISHED }, state({ phase: "idle" }));
  await screen.findByText("Search");
  expect(screen.queryByText("Searching")).toBeNull();
  cleanup();
  start([
    { kind: "user", text: "go" },
    { kind: "tool", text: `TodoWrite ${JSON.stringify(todos)}` },
    { error: true, kind: "echo", text: "InputValidationError" },
  ]);
  const failed = await screen.findByText("Failed");
  expect(failed.closest('[data-slot="plan"]')).toBeTruthy();
});

const plan = () => screen.getByText("0 of 2 done").closest<HTMLElement>('[data-slot="plan"]');
// neither its step in progress's present tense nor any running line
const notLive = () => {
  expect(screen.queryByText("Searching")).toBeNull();
  expect(plan()?.querySelector('[data-status="running"]')).toBeNull();
};

// the plan stays with its turn: once another turn runs, or the turn stops for a model, it is no
// longer live, newest in the chat or not
test("an older turn's plan is never live: not while a new turn without one runs, nor while that turn waits for a model", async () => {
  const todos = { todos: [{ activeForm: "Searching", content: "Search", status: "in_progress" }, { content: "Answer", status: "pending" }] };
  const { play } = start([
    { kind: "user", text: "go" },
    { kind: "tool", text: `TodoWrite ${JSON.stringify(todos)}` },
    { kind: "echo", text: "ok" },
    // the turn stopped mid-plan (cancelled); the next one plans nothing
    { kind: "user", text: "something else" },
  ]);
  await screen.findByText("something else");
  notLive();
  // a new turn, from entry 3, runs
  play({ runId: "3", threadId: "mini", type: EventType.RUN_STARTED }, state({ phase: "running" }));
  await waitFor(() => {
    expect(screen.getByTestId("status").textContent).toContain("running");
  });
  notLive();
  // it stops on a usage limit and waits for a model
  play(state({ phase: "needs-model", stopped: { label: "Claude Opus (Claude Code)", ref: "claude-code:opus", why: "usage limit" } }), { message: "usage limit", type: EventType.RUN_ERROR });
  await screen.findByTestId("needs-model");
  notLive();
  // the newest plan in the chat is still the one open
  expect(plan()?.dataset.state).toBe("open");
});

const write = (statuses: readonly string[]) => `TodoWrite ${JSON.stringify({ todos: statuses.map((status, k) => ({ content: `step ${k}`, status })) })}`;

test("a turn's earlier TodoWrite calls fold into its latest plan: one Plan, the earlier states plain tool lines", async () => {
  start([
    { kind: "user", text: "go" },
    { kind: "tool", text: write(["in_progress", "pending"]) },
    { kind: "echo", text: "ok" },
    { kind: "tool", text: write(["completed", "completed"]) },
    { kind: "echo", text: "ok" },
    { kind: "talk", text: "done" },
  ]);
  await screen.findByText("done");
  expect(document.querySelectorAll('[data-slot="plan"]')).toHaveLength(1);
  expect(screen.getByText("2 of 2 done")).toBeTruthy();
  expect(screen.queryByText("0 of 2 done")).toBeNull();
  // the earlier call is a tool line, its input as logged a click away
  const earlier = [...document.querySelectorAll('[data-slot="tool"]')].filter((t) => t.textContent.includes("TodoWrite"));
  expect(earlier).toHaveLength(1);
});

// a message steered into a run is a user row, which starts a turn of its own: the run then holds
// two turns' plans, and only its newest is live
const doing = (step: string) => `TodoWrite ${JSON.stringify({ todos: [{ activeForm: `${step}ing`, content: step, status: "in_progress" }] })}`;
test("a steer inside a run leaves one live plan: the newest; the one before the steer closes", async () => {
  const { play } = start([
    { kind: "user", text: "go" },
    { kind: "tool", text: doing("Search") },
    { kind: "echo", text: "ok" },
    { kind: "user", text: "and read the page too" },
    { kind: "tool", text: doing("Read") },
    { kind: "echo", text: "ok" },
  ]);
  await screen.findByText("Read");
  play({ runId: "0", threadId: "mini", type: EventType.RUN_STARTED }, state({ phase: "running" }));
  await screen.findByText("Reading");
  const plans = [...document.querySelectorAll<HTMLElement>('[data-slot="plan"]')];
  expect(plans).toHaveLength(2);
  const live = plans.filter((p) => p.querySelector('[data-status="running"]') !== null);
  expect(live).toHaveLength(1);
  expect(live[0]?.textContent).toContain("Reading");
  expect(screen.queryByText("Searching")).toBeNull();
  expect(plans.map((p) => p.dataset.state)).toEqual(["closed", "open"]);
});
