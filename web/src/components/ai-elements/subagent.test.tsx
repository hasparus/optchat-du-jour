// AI Elements' Subagent (SPEC M7a's presentational part, chat/subagents.tsx wires it): each state from the
// runs the story page shows, and its Tell and Stop callbacks
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RUNS } from "@/stories/subagent-runs";
import { Subagent, type SubagentRun } from "./subagent";

afterEach(cleanup);

const run = (status: SubagentRun["status"]) => {
  const found = RUNS.find((r) => r.status === status);
  if (!found) throw new Error(`no ${status} run`);
  return found;
};

describe("Subagent", () => {
  test("running: open, shimmering, its task, where it runs, its steps (the last one running), Stop and Tell", () => {
    const calls: string[] = [];
    render(
      <Subagent
        onStop={(name) => {
          calls.push(`stop ${name}`);
        }}
        onTell={(name, text) => {
          calls.push(`tell ${name}: ${text}`);
        }}
        run={run("running")}
      />,
    );
    const root = document.querySelector<HTMLElement>('[data-slot="subagent"]');
    expect(root?.dataset.state).toBe("open");
    expect(root?.dataset.status).toBe("running");
    expect(screen.getByText("Running scout").closest<HTMLElement>('[data-slot="trace-line"]')?.dataset.status).toBe("running");
    expect(screen.getByText("1 min 05 s")).toBeTruthy();
    expect(screen.getByText("on macbook")).toBeTruthy();
    expect(screen.getByText("Claude Sonnet (Claude Code)")).toBeTruthy();
    const steps = [...document.querySelectorAll<HTMLElement>('[data-slot="subagent-steps"] [data-slot="tool"]')];
    expect(steps.map((s) => s.querySelector<HTMLElement>('[data-slot="tool-status"]')?.textContent)).toEqual(["Completed", "Running"]);
    // a blank message isn't told; one with text is, and the line clears
    const box = screen.getByLabelText("Tell scout");
    fireEvent.submit(box);
    fireEvent.change(box, { target: { value: "skip vendor/" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to scout" }));
    expect(box).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Stop scout" }));
    expect(calls).toEqual(["tell scout: skip vendor/", "stop scout"]);
  });

  test("finished: closed until opened, then its report; no Stop or Tell", () => {
    const calls: string[] = [];
    render(
      <Subagent
        onStop={(name) => {
          calls.push(name);
        }}
        onTell={(name) => {
          calls.push(name);
        }}
        run={run("finished")}
      />,
    );
    const root = document.querySelector<HTMLElement>('[data-slot="subagent"]');
    expect(root?.dataset.state).toBe("closed");
    fireEvent.click(screen.getByText("Ran notes"));
    expect(root?.dataset.state).toBe("open");
    expect(within(root ?? document.body).getByText(/the newest \(Oct 3\) has the dates/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(screen.queryByLabelText(/^Tell/)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("failed and stopped: their titles and why; a failed one reads as an error, its failed step too", () => {
    render(
      <>
        <Subagent defaultOpen run={run("failed")} />
        <Subagent defaultOpen run={run("stopped")} />
      </>,
    );
    expect(screen.getByText("Failed to run builder").closest<HTMLElement>('[data-slot="trace-line"]')?.dataset.status).toBe("error");
    expect(screen.getByText("usage limit: Claude AI usage limit reached")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy(); // the step's flag (E28)
    expect(screen.getByText("Stopped reader").closest<HTMLElement>('[data-slot="trace-line"]')?.dataset.status).toBeUndefined();
    expect(screen.getByText("stopped by you")).toBeTruthy();
  });

  test("without callbacks a running one has neither Stop nor Tell", () => {
    render(<Subagent run={run("running")} />);
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(screen.queryByLabelText(/^Tell/)).toBeNull();
  });
});
