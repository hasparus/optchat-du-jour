// A file tool's change under its line (lib/diff.ts, ./tool-diff.tsx): an Edit as a red and green
// diff with its counts, a Write as its new file closed behind its line count, both drawn while the
// input streams (E45); the input and output as logged stay one tap away.
import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { start, stubApi } from "@/test/app";
import { state } from "@/test/fixture";
import { DIFF_SHOWN } from "./tool-diff";

stubApi();

// in the order Claude Code writes its keys
const EDIT = JSON.stringify({ file_path: "src/app.ts", old_string: "const a = 1;\nconst b = 2;\n", new_string: "const a = 1;\nconst b = 3;\nconst c = 4;\n" });
// each line of a block as its kind and its text
const kinds = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>("[data-diff]")].map((l) => `${l.dataset.diff} ${l.querySelector('[data-slot="diff-text"]')?.textContent}`);

test("an Edit shows as its diff under the line, with its counts; its raw input stays behind the line", async () => {
  start([
    { kind: "user", text: "bump b" },
    { kind: "tool", text: `Edit ${EDIT}` },
    { kind: "echo", text: "The file src/app.ts has been updated." },
  ]);
  const diff = await screen.findByTestId("tool-diff");
  expect(kinds(diff)).toEqual(["same const a = 1;", "del const b = 2;", "add const b = 3;", "add const c = 4;"]);
  // a screen reader hears what each changed line is
  expect(diff.querySelector('[data-diff="del"]')?.textContent).toContain("removed:");
  const row = within(diff.closest<HTMLElement>('[data-kind="tool"]') ?? document.body);
  expect(row.getByTestId("diff-stat").textContent).toContain("+2 −1");
  expect(row.getByText("src/app.ts")).toBeTruthy();
  // the line opens to the input as logged, and the output
  fireEvent.click(row.getByText("Edit"));
  expect(await row.findByText("Input")).toBeTruthy();
  expect(row.getByText(/has been updated/)).toBeTruthy();
});

test("a MultiEdit is a hunk per edit; a long diff shows its first lines, then the rest on a tap", async () => {
  const many = Array.from({ length: 30 }, (_, k) => `line ${k}`).join("\n");
  const multi = JSON.stringify({ file_path: "a.md", edits: [{ old_string: "x", new_string: "y" }, { old_string: "", new_string: many }] });
  start([
    { kind: "user", text: "go" },
    { kind: "tool", text: `MultiEdit ${multi}` },
    { kind: "echo", text: "ok" },
  ]);
  const diff = await screen.findByTestId("tool-diff");
  expect(diff.querySelectorAll("[data-diff]")).toHaveLength(DIFF_SHOWN - 1); // the rule between the hunks takes a place
  fireEvent.click(within(diff).getByRole("button", { name: "Show 9 more lines" }));
  expect(diff.querySelectorAll("[data-diff]")).toHaveLength(32);
  expect(screen.getByTestId("diff-stat").textContent).toContain("+31 −1");
});

test("a Write is closed behind its line count, and opens to the new file", async () => {
  const content = "# Notes\n\n- one\n- two\n";
  start([
    { kind: "user", text: "write notes" },
    { kind: "tool", text: `Write ${JSON.stringify({ file_path: "notes.md", content })}` },
    { kind: "echo", text: "File created successfully at: notes.md" },
  ]);
  const toggle = await screen.findByTestId("new-file-toggle");
  expect(toggle.textContent).toBe("New file · 4 lines");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("new-file")).toBeNull();
  fireEvent.click(toggle);
  const file = screen.getByTestId("new-file");
  expect(kinds(file)).toEqual(["same # Notes", "same  ", "same - one", "same - two"]); // an empty line keeps its height
});

test("while an Edit's input streams the diff grows with it, then the logged call replaces it", async () => {
  const { play } = start([{ kind: "user", text: "bump b" }]);
  await screen.findByText("bump b");
  play(state({ engine: "claude-code:opus", phase: "running" }), { runId: "0", threadId: "mini", type: EventType.RUN_STARTED });
  const cut = EDIT.indexOf("b = 3") + 5;
  play(
    { parentMessageId: "1", toolCallId: "t1", toolCallName: "Edit", type: EventType.TOOL_CALL_START },
    { delta: EDIT.slice(0, 40), toolCallId: "t1", type: EventType.TOOL_CALL_ARGS },
    { delta: EDIT.slice(40, cut), toolCallId: "t1", type: EventType.TOOL_CALL_ARGS },
  );
  const diff = await screen.findByTestId("tool-diff");
  expect(kinds(diff).filter((l) => l.startsWith("add"))).toEqual(["add const b = 3"]);
  expect(screen.getByText("src/app.ts")).toBeTruthy(); // the path, read from the input so far
  play({ delta: EDIT.slice(cut), toolCallId: "t1", type: EventType.TOOL_CALL_ARGS });
  expect(kinds(screen.getByTestId("tool-diff")).filter((l) => l.startsWith("add"))).toEqual(["add const b = 3;", "add const c = 4;"]);
  // the entry as logged: the same diff, under the same row
  play(
    { parentMessageId: "1", toolCallId: "t1", toolCallName: "Edit", type: EventType.TOOL_CALL_START },
    { delta: EDIT, toolCallId: "t1", type: EventType.TOOL_CALL_ARGS },
    { toolCallId: "t1", type: EventType.TOOL_CALL_END },
  );
  expect(screen.getAllByTestId("tool-diff")).toHaveLength(1);
  expect(screen.getByTestId("diff-stat").textContent).toContain("+2 −1");
});
