// What the model thought, above the reply or tool call it came before (SPEC "Reasoning"; the
// Reasoning pattern, components/ai-elements/reasoning.tsx): live as it streams, and after a reload
// from /api/reasoning, its text read only when the line is opened.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LOG, start, stubApi, THOUGHTS, thoughtReads } from "../test/app";
import { said, state } from "../test/fixture";
import type { Inbound } from "../lib/protocol";

stubApi();

const line = (name: RegExp) => screen.getByRole("button", { name });
const thinking = (at: number, delta: string): Inbound[] => [
  { messageId: `r${at}`, type: EventType.REASONING_START },
  { messageId: `r${at}`, role: "reasoning", type: EventType.REASONING_MESSAGE_START },
  { delta, messageId: `r${at}`, type: EventType.REASONING_MESSAGE_CONTENT },
];
const keptAt = (at: number, i: number, ms: number): Inbound[] => [
  { messageId: `r${at}`, type: EventType.REASONING_MESSAGE_END },
  { messageId: `r${at}`, metadata: { i, ms }, type: EventType.REASONING_END },
];

test("live: the thought streams collapsed, shimmering, in the row its reply then takes; opened, it shows what it thought, and stays open as the reply comes", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "user", "and the tests?"), { runId: "4", threadId: "mini", type: EventType.RUN_STARTED }, state({ engine: "claude-code:opus", phase: "running" }), ...thinking(5, "The user asks about tests. "));
  const trigger = await screen.findByRole("button", { name: /Thinking…/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.querySelector<HTMLElement>('[data-slot="trace-line"]')?.dataset.status).toBe("running"); // the shimmer
  expect(screen.queryByText(/The user asks about tests/)).toBeNull(); // collapsed by default, also while it streams
  // its row is the one the reply will take: keyed by the index the reply is expected at
  const row = trigger.closest<HTMLElement>('[data-slot="message-scroller-item"]');
  expect(row?.dataset.logIndex).toBe("5");
  expect(row?.dataset.kind).toBe("thinking");
  fireEvent.click(trigger);
  await screen.findByText(/The user asks about tests\./);
  play({ delta: "There are none yet.", messageId: "r5", type: EventType.REASONING_MESSAGE_CONTENT });
  await screen.findByText("The user asks about tests. There are none yet.");
  play(...said(5, "assistant", "There are no tests yet."), ...keptAt(5, 5, 3200));
  await screen.findByText("There are no tests yet.");
  const done = line(/Thought for 3 s/);
  expect(done.getAttribute("aria-expanded")).toBe("true"); // the reader opened it: it stays open
  expect(done.closest('[data-slot="message-scroller-item"]')).toBe(row);
  expect(row?.dataset.kind).toBe("talk");
  expect(within(row ?? document.body).getByText("There are no tests yet.")).toBeTruthy();
  // the reply's raw toggle is still there, under the reply
  expect(within(row ?? document.body).getByRole("button", { name: "Show raw text" })).toBeTruthy();
});

test("live: a thought before a tool call sits above its line; one the turn dropped goes, and so does one still streaming when the run ends", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play({ runId: "4", threadId: "mini", type: EventType.RUN_STARTED }, state({ phase: "running" }), ...thinking(4, "Glob first."));
  await screen.findByRole("button", { name: /Thinking…/ });
  play(
    { parentMessageId: "4", toolCallId: "t4", toolCallName: "Glob", type: EventType.TOOL_CALL_START },
    { delta: '{"pattern":"*.test.ts"}', toolCallId: "t4", type: EventType.TOOL_CALL_ARGS },
    { toolCallId: "t4", type: EventType.TOOL_CALL_END },
    ...keptAt(4, 4, 400),
  );
  const reasoning = await screen.findByRole("button", { name: /^Reasoning/ }); // under a second
  const tool = screen.getByText(/^Glob/);
  expect(reasoning.closest('[data-slot="message-scroller-item"]')).toBe(tool.closest('[data-slot="message-scroller-item"]'));
  expect(reasoning.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  play(...thinking(6, "never followed"), { messageId: "r6", metadata: { dropped: true }, type: EventType.REASONING_END });
  play(...thinking(6, "cut off by the end"));
  await screen.findByRole("button", { name: /Thinking…/ });
  play({ message: "cancelled", type: EventType.RUN_ERROR });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /Thinking…/ })).toBeNull();
  });
  expect(screen.getAllByRole("button", { name: /^Reasoning/ })).toHaveLength(1);
});

test("after a reload: a reply's thought shows collapsed with how long it took, its text read once when it is first opened", async () => {
  THOUGHTS.set(3, { ms: 12_400, text: "Two entries: name both, bold the first." });
  start(LOG);
  await screen.findByText("what is in the repo?");
  const trigger = await screen.findByRole("button", { name: /Thought for 12 s/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(thoughtReads).toEqual([]); // nothing read until it is opened
  fireEvent.click(trigger);
  await screen.findByText("Two entries: name both, bold the first.");
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  await screen.findByText("Two entries: name both, bold the first.");
  expect(thoughtReads).toEqual([3]);
  // the reply under it reads as before: rendered, with its raw toggle
  fireEvent.click(screen.getByRole("button", { name: "Show raw text" }));
  expect(screen.getByText("Two things: **notes** and a repo.")).toBeTruthy();
});
