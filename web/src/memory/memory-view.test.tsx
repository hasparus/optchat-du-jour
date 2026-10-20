// The memory view in the chat and on the Memory screen (E46): the app against a scripted socket,
// with /api/memory/* answered by the server's own memory in this process (test/app.tsx MEMORY) and
// its feed's frames played over the socket as they are made. A summary opens in place, down to its
// messages; a line waiting for its summary fills in when the frame that says it was written comes,
// with no read of the view; the chat's toggle and the Memory screen draw the same blocks.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { watchMemory } from "../../../server/memory-feed.ts";
import { newMsg, newNode } from "../../../src/store.ts";
import { built, type Mem, newMem, nodes, ready } from "../../../src/tree.ts";
import { addMessage, addNode } from "../../../src/view.ts";
import type { Inbound } from "../lib/protocol";
import { MEMORY, start, stubApi } from "../test/app";

stubApi();

// A chat of `count` long messages (each past NODE: summarized, not its own line), every node
// summarized as it becomes ready but the last message's, and marks so small that batches merge
// the view into a few high lines; the feed's frames, kept to play
function memory(count: number) {
  const mem: Mem = newMem({ high: 120, low: 60 }, { high: 60, low: 30 });
  const frames: Inbound[] = [];
  const feed = watchMemory(mem, (e) => {
    if (e.type === "memory") frames.push({ name: "memory", type: EventType.CUSTOM, value: e.change });
  }, { start: 500 });
  const summarizeAll = (but: number | null) => {
    for (let more = true; more; ) {
      more = false;
      for (const c of nodes(mem.root.length))
        if (!built(mem, c) && ready(mem, c) && !(c.l === 0 && c.i === but)) {
          addNode(mem, newNode(c.l, c.i, `summary ${c.l}:${c.i}`));
          more = true;
        }
    }
  };
  for (let i = 0; i < count; i++) {
    addMessage(mem, newMsg(i, i % 2 === 0 ? "user" : "talk", `message ${i} ${"w".repeat(600)}`));
    summarizeAll(i === count - 1 ? i : null);
  }
  MEMORY.mem = mem;
  MEMORY.rev = feed.rev;
  frames.length = 0; // a page read now is as of all of these
  return { feed, frames, mem, summarizeAll };
}

const blocks = () => screen.queryAllByTestId("memory-block");
const memoryMode = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  await waitFor(() => {
    expect(blocks().length).toBeGreaterThan(0);
  });
};

test("the chat's Memory mode shows the view's summaries, and a summary opens in place, down to its messages", async () => {
  const s = memory(12);
  start();
  await screen.findByText("what is in the repo?"); // the log, by default
  await memoryMode();
  expect(screen.queryByText("what is in the repo?")).toBeNull(); // the log's rows gave way to the view's
  const top = blocks().find((b) => Number(b.dataset.level) >= 2);
  if (top === undefined) throw new Error(`no summary of level 2 or more: ${blocks().map((b) => b.dataset.node).join(" ")}`);
  const level = Number(top.dataset.level), node = top.dataset.node ?? "";
  expect(top.textContent).toContain(`summary ${node}`);
  fireEvent.click(top);
  // its two halves, inside it, a level down, read from /api/memory/children
  const opened = await waitFor(() => {
    const here = blocks().find((b) => b.dataset.node === node);
    const inner = here === undefined ? [] : within(here).queryAllByTestId("memory-block");
    expect(inner.length).toBe(2);
    return { here, inner };
  });
  expect(opened.inner.map((b) => Number(b.dataset.level))).toEqual([level - 1, level - 1]);
  expect(MEMORY.reads.some((r) => r.startsWith(`/api/memory/children?l=${level}&`))).toBe(true);
  // down to the messages: a level-0 summary of something said in the conversation opens to it
  for (let at = opened.inner[0]; at !== undefined && Number(at.dataset.level) > 0; ) {
    const key = at.dataset.node ?? "";
    fireEvent.click(at);
    at = await waitFor(() => {
      const here = blocks().find((b) => b.dataset.node === key);
      const first = here === undefined ? undefined : within(here).queryAllByTestId("memory-block")[0];
      expect(first).toBeDefined();
      return first;
    });
  }
  await screen.findByText(/^message 0 w+$/);
  expect(screen.getAllByText("The model reads:").length).toBeGreaterThan(0);
  // back to the log: the same rows as before
  fireEvent.click(screen.getByRole("button", { name: "Log" }));
  await screen.findByText("what is in the repo?");
  expect(blocks()).toEqual([]);
  s.feed.close();
});

test("a line waiting for its summary fills in live, when the frame that says it was written comes", async () => {
  const s = memory(5);
  const { play } = start();
  await screen.findByText("what is in the repo?");
  await memoryMode();
  const last = await waitFor(() => {
    const unbuilt = blocks().find((b) => b.dataset.node === "0:4");
    if (unbuilt === undefined) throw new Error("no line 0:4 yet");
    expect(unbuilt.dataset.built).toBe("false");
    return unbuilt;
  });
  expect(within(last).getAllByText("Summarizing…").length).toBeGreaterThan(0);
  const reads = MEMORY.reads.filter((r) => r.startsWith("/api/memory/view")).length;
  // the compactor writes it on the server: the feed's frame crosses the socket
  s.summarizeAll(null);
  expect(s.frames.length).toBeGreaterThan(0);
  play(...s.frames.splice(0));
  await waitFor(() => {
    expect(blocks().find((b) => b.dataset.node === "0:4")?.dataset.built).toBe("true");
  });
  await screen.findByText("summary 0:4");
  expect(screen.queryAllByText("Summarizing…")).toEqual([]);
  // filled from the frame alone: the view was not read again
  expect(MEMORY.reads.filter((r) => r.startsWith("/api/memory/view")).length).toBe(reads);
  // a message logged later: its line comes the same way, after the others
  act(() => {
    addMessage(s.mem, newMsg(5, "tool", `Bash ${JSON.stringify({ command: "x".repeat(600) })}`));
  });
  play(...s.frames.splice(0));
  await waitFor(() => {
    expect(blocks().at(-1)?.dataset.node).toBe("0:5");
  });
  expect(blocks().at(-1)?.textContent).toContain("Tool call");
  s.feed.close();
});

test("the Memory screen draws the same live blocks, with how full the view is, and shows a block's messages in the log", async () => {
  const s = memory(6);
  start();
  await screen.findByText("what is in the repo?");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "memory" }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name: "memory" }));
  const screenEl = await screen.findByTestId("memory");
  await waitFor(() => {
    expect(within(screenEl).queryAllByTestId("memory-block").length).toBeGreaterThan(0);
  });
  expect(screenEl.textContent).toMatch(/What the model reads each turn: \d+ lines/);
  const [first] = within(screenEl).getAllByTestId("memory-block");
  if (first === undefined) throw new Error("no block");
  fireEvent.click(first);
  const [show] = await within(screenEl).findAllByRole("button", { name: /Show in the log/ });
  if (show === undefined) throw new Error("no Show in the log");
  fireEvent.click(show);
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "chat" }).dataset.state).toBe("active");
  });
  s.feed.close();
});
