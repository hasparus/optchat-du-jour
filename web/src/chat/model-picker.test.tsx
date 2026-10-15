// The composer's model picker (SPEC "Web UI", Composer): with a mouse AI Elements' Model Selector,
// on a touch screen the phone's own select; either way this page's own, sending nothing.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { box, frames, LOG, onTouchScreen, start, stubApi, type } from "../test/app";
import { IDLE, state } from "../test/fixture";

stubApi();

test("with a mouse the model picker is the Model Selector: a menu grouped by where each engine runs; picking sends nothing, the next message names it", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  play(
    state({
      engines: [
        { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
        { down: null, label: "Claude Opus (Claude Code, xhigh)", ref: "claude-code:opus@xhigh" },
        { down: "Claude AI usage limit reached", label: "Claude Sonnet (Claude Code)", ref: "claude-code:sonnet" },
        { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
      ],
    }),
  );
  expect(screen.queryByLabelText("Model")).toBeNull(); // no native select with a mouse
  const trigger = screen.getByTestId("model-picker");
  expect(trigger.getAttribute("aria-label")).toBe("Model: Claude Opus (Claude Code)");
  fireEvent.keyDown(trigger, { key: "Enter" });
  const menu = await screen.findByTestId("model-menu");
  expect([...menu.querySelectorAll('[data-slot="dropdown-menu-group"]')].map((g) => g.firstElementChild?.textContent)).toEqual(["Claude Code", "ChatGPT plan"]);
  const items = within(menu).getAllByRole("menuitemradio");
  expect(items.map((i) => [i.textContent, i.getAttribute("aria-checked"), i.dataset.disabled !== undefined])).toEqual([
    ["Opus", "true", false],
    ["Opusxhigh", "false", false],
    ["Sonnetunavailable: Claude AI usage limit reached", "false", true],
    ["GPT-6.1 Sol", "false", false],
  ]);
  const before = server.sent.length;
  fireEvent.click(within(menu).getByText("GPT-6.1 Sol"));
  await waitFor(() => {
    expect(screen.queryByTestId("model-menu")).toBeNull();
  });
  expect(server.sent).toHaveLength(before); // picking sends nothing
  expect(screen.getByTestId("model-picker").textContent).toContain("GPT-6.1 Sol");
  expect(localStorage.getItem("optchat:model")).toBe("openai-plan:gpt-6.1-sol");
  type("hello Sol");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" }, messages: [{ content: "hello Sol" }] });
});

test("on a touch screen the model picker is the phone's own select, and this page's own: switching it sends nothing; each message names the model picked when it was sent", async () => 
  onTouchScreen(async () => {
    const { play, server } = start();
    await screen.findByText("what is in the repo?");
    const model = screen.getByLabelText<HTMLSelectElement>("Model");
    expect([...model.options].map((o) => o.textContent)).toEqual(["Claude Opus (Claude Code)", "GPT-6.1 Sol (ChatGPT plan)"]);
    expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy(); // none picked: the chain's first
    const before = server.sent.length;
    fireEvent.change(model, { target: { value: "openai-plan:gpt-6.1-sol" } });
    fireEvent.change(model, { target: { value: "claude-code:opus" } });
    fireEvent.change(model, { target: { value: "openai-plan:gpt-6.1-sol" } });
    expect(server.sent).toHaveLength(before); // nothing went out
    expect(within(screen.getByTestId("model-picker")).getByText("GPT-6.1 Sol")).toBeTruthy();
    expect(localStorage.getItem("optchat:model")).toBe("openai-plan:gpt-6.1-sol");
    type("hello Sol");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" }, messages: [{ content: "hello Sol" }] });
    // the queue names a message's model only where it isn't the picker's
    play(
      state({
        pending: [
          { clientId: "a", engine: "claude-code:opus", queued: true, text: "for opus" },
          { clientId: "b", engine: "openai-plan:gpt-6.1-sol", queued: true, text: "for sol" },
        ],
        phase: "running",
      }),
    );
    const [opus, sol] = await screen.findAllByTestId("queue-item");
    expect(within(opus ?? document.body).getByTestId("queue-engine").textContent).toBe("Opus");
    expect(within(sol ?? document.body).queryByTestId("queue-engine")).toBeNull();
    // the server's word on the engines: Opus is down, with why
    play(
      state({
        engines: [
          { down: "Claude AI usage limit reached", label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
          { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
        ],
      }),
    );
    const [down] = [...screen.getByLabelText<HTMLSelectElement>("Model").options];
    expect([down?.disabled, down?.textContent]).toEqual([true, "Claude Opus (Claude Code): unavailable, Claude AI usage limit reached"]);
    // the closed picker marks its own engine when that one is down
    expect(screen.queryByTestId("picker-down")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus" } });
    expect(screen.getByTestId("picker-down")).toBeTruthy();
    // while a turn runs on Sol, a message for Opus waits for a turn of its own: no "send now"
    play(state({ engine: "openai-plan:gpt-6.1-sol", phase: "running" }));
    type("for opus");
    expect(box().getAttribute("placeholder")).toBe("For the next turn (another model)");
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("title")).toBe("Send (waits for the next turn: another model)");
    expect(screen.queryByRole("button", { name: /^(Send now|Queue for the next turn)$/ })).toBeNull();
  }));

test("on a touch screen, one model at two efforts reads apart: the picker, a queued message and the status line show the effort as the picker's options do", async () => 
  onTouchScreen(async () => {
    const { play } = start();
    await screen.findByText("what is in the repo?");
    const engines = [
      { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "Claude Opus (Claude Code, xhigh)", ref: "claude-code:opus@xhigh" },
    ];
    play(state({ engines }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus@xhigh" } });
    // the picker: a bare label, the model's name and its effort beside it
    expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy();
    expect(within(screen.getByTestId("model-picker")).getByText("xhigh")).toBeTruthy();
    expect(screen.getByTestId("model-picker").className).toContain("bare-control");
    play(state({ engine: "claude-code:opus@xhigh", pending: [{ clientId: "a", engine: "claude-code:opus", queued: true, text: "for opus" }], phase: "running" }));
    const opus = await screen.findByTestId("queue-engine");
    expect(opus.textContent).toBe("Opus");
    expect(screen.getByTestId("status").textContent).toContain("running on mini, Claude Opus (Claude Code, xhigh)");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus" } });
    play(state({ pending: [{ clientId: "b", engine: "claude-code:opus@xhigh", queued: true, text: "for opus at xhigh" }] }));
    const other = await screen.findByTestId("queue-engine");
    expect([other.textContent, other.getAttribute("title")]).toEqual(["Opus · xhigh", "for Claude Opus (Claude Code, xhigh)"]);
  }));

test("a pick kept with the master's own effort (\"@xhigh\" once the master runs at xhigh) still finds its engine, and is kept as the chain spells it", async () => {
  localStorage.setItem("optchat:model", "claude-code:opus@xhigh");
  const { play, server } = start(LOG, 0, undefined, true);
  await screen.findByText("what is in the repo?");
  play({
    snapshot: {
      ...IDLE,
      effort: "xhigh",
      engines: [
        { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
        { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      ],
    },
    type: EventType.STATE_SNAPSHOT,
  });
  expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy();
  expect(localStorage.getItem("optchat:model")).toBe("claude-code:opus");
  type("still on opus");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "claude-code:opus" } });
});

test("before the first state, a message names the model this page kept; once the state shows the chain lacks it, the chain's first", async () => {
  localStorage.setItem("optchat:model", "openai-plan:gpt-6.1-sol");
  const { play, server } = start(LOG, 0, undefined, true);
  await screen.findByText("what is in the repo?");
  type("right after a reload");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" } });
  play({ snapshot: { ...IDLE, engines: [{ down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" }] }, type: EventType.STATE_SNAPSHOT });
  expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy();
  type("after the state");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "claude-code:opus" } });
});

test("on a touch screen, a turn stopped on a usage limit: every client shows why and the engines to go on with; a button resumes, and the picker follows it", async () => 
  onTouchScreen(async () => {
    const { play, server } = start();
    await screen.findByText("what is in the repo?");
    play(
      state({
        engines: [
          { down: "Claude AI usage limit reached", label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
          { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
        ],
        phase: "needs-model",
        stopped: { label: "Claude Opus (Claude Code)", ref: "claude-code:opus", why: "usage limit: Claude AI usage limit reached" },
      }),
    );
    // the run's end that follows is not said again in the chat: the prompt says it, once
    play({ message: "usage limit: Claude AI usage limit reached", type: EventType.RUN_ERROR });
    const alert = await screen.findByTestId("needs-model");
    expect(alert.textContent).toContain("Claude Opus (Claude Code): usage limit: Claude AI usage limit reached. Choose how to go on:");
    expect(screen.queryByTestId("marker-error")).toBeNull();
    // a message sent while it waits meets the turn as a running one would: it joins once the turn
    // goes on, or (the other button) waits for the next turn
    expect(box().getAttribute("placeholder")).toBe("Add to the turn, once it goes on");
    type("meanwhile");
    expect(screen.getByRole("button", { name: "Queue for the next turn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    type("");
    expect(screen.queryByTestId("status")).toBeNull();
    // moving the picker resumes nothing
    const before = server.sent.length;
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "openai-plan:gpt-6.1-sol" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus" } });
    expect(server.sent).toHaveLength(before);
    fireEvent.click(within(alert).getByRole("button", { name: "Continue with GPT-6.1 Sol (ChatGPT plan)" }));
    expect(frames(server.sent).at(-1)).toEqual({ engine: "openai-plan:gpt-6.1-sol", type: "resume" });
    expect(within(screen.getByTestId("model-picker")).getByText("GPT-6.1 Sol")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Try Claude Opus (Claude Code) again" }));
    expect(frames(server.sent).at(-1)).toEqual({ engine: "claude-code:opus", type: "resume" });
  }));

test("with a mouse, one model at two efforts reads apart: the trigger shows the picked one's effort beside its name, and each item its own", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(
    state({
      engines: [
        { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
        { down: null, label: "Claude Opus (Claude Code, xhigh)", ref: "claude-code:opus@xhigh" },
      ],
    }),
  );
  fireEvent.keyDown(screen.getByTestId("model-picker"), { key: "Enter" });
  const menu = await screen.findByTestId("model-menu");
  const items = within(menu).getAllByRole("menuitemradio");
  // the name, then the effort in a span of its own (nothing for the entry at the role's)
  expect(items.map((i) => [...(i.querySelector('[data-slot="model-shown"]')?.children ?? [])].map((c) => c.textContent))).toEqual([["Opus"], ["Opus", "xhigh"]]);
  fireEvent.click(within(menu).getByText("xhigh"));
  await waitFor(() => {
    expect(screen.queryByTestId("model-menu")).toBeNull();
  });
  const trigger = screen.getByTestId("model-picker");
  expect(trigger.getAttribute("aria-label")).toBe("Model: Claude Opus (Claude Code, xhigh)");
  expect(within(trigger).getByText("Opus")).toBeTruthy();
  expect(within(trigger).getByText("xhigh")).toBeTruthy();
  expect(trigger.className).toContain("bare-control");
});
