// Esc, and Enter in an empty composer, stop the running turn as Stop does (lib/stop-keys.ts,
// ./use-stop-keys.ts); not while an input method composes, a sheet or a popover takes the key, the
// artifact pane or a select has focus, a paste preview is open, or another tab is shown; not when no
// turn runs; not on a touch screen, where Enter is a new line; not as the second press of an Enter
// that sent; and Enter with something typed still sends.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ENTER_AFTER_SEND_MS, escapeStops, type KeyLike } from "@/lib/stop-keys";
import { box, onTouchScreen, start, stubApi, type } from "@/test/app";
import { actionsOf, state } from "@/test/fixture";

stubApi();
afterEach(() => {
  setSystemTime(); // the real clock again
});

// the aborts the app sent, each for the run of the turn loop the user saw (E41)
const aborts = (sent: readonly string[]) => actionsOf(sent).filter((f) => f.type === "abort" && f.loop === LOOP).length;
const LOOP = 3;

const running = async () => {
  const app = start();
  await screen.findByText("what is in the repo?");
  app.play(state({ engine: "claude-code:opus", loop: LOOP, phase: "running" }));
  await screen.findByRole("button", { name: "Stop" });
  return app;
};

test("Esc stops the running turn, from the composer or anywhere on the chat; not when no turn runs", async () => {
  const { play, server } = await running();
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(aborts(server.sent)).toBe(1);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(aborts(server.sent)).toBe(2);
  // with a modifier, held down, or once the turn is over: nothing
  fireEvent.keyDown(document.body, { key: "Escape", shiftKey: true });
  fireEvent.keyDown(document.body, { key: "Escape", repeat: true });
  play(state({ phase: "idle" }));
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(aborts(server.sent)).toBe(2);
});

test("Esc is left to an input method that composes, a sheet or a popover, the artifact pane and a select", async () => {
  const { server } = await running();
  fireEvent.keyDown(box(), { isComposing: true, key: "Escape" });
  fireEvent.keyDown(box(), { key: "Escape", keyCode: 229 });
  // Background work, a sheet: its Escape closes it
  fireEvent.click(within(screen.getByTestId("status")).getByRole("button"));
  const sheet = await screen.findByRole("dialog", { name: "Background work" });
  fireEvent.keyDown(document.activeElement ?? sheet, { key: "Escape" });
  fireEvent.animationEnd(sheet);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Background work" })).toBeNull();
  });
  // the follow-ups popover: its Escape closes it
  fireEvent.click(screen.getByRole("button", { name: /^Follow-ups:/ }));
  const popover = await screen.findByRole("dialog");
  fireEvent.keyDown(document.activeElement ?? popover, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(aborts(server.sent)).toBe(0);

  // what owns its keys (the artifact pane marks itself so), and a native select
  const pane = document.createElement("div");
  pane.dataset.keys = "own";
  const field = document.createElement("input");
  pane.append(field);
  document.body.append(pane);
  fireEvent.keyDown(field, { key: "Escape" });
  fireEvent.keyDown(screen.getByLabelText("Device"), { key: "Escape" });
  expect(aborts(server.sent)).toBe(0);
  pane.remove();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(aborts(server.sent)).toBe(1);
});

test("Esc on another tab stops nothing; back on the chat, it does", async () => {
  const { server } = await running();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "memory" }));
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "memory" }).getAttribute("aria-selected")).toBe("true");
  });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(aborts(server.sent)).toBe(0);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "chat" }));
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "chat" }).getAttribute("aria-selected")).toBe("true");
  });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(aborts(server.sent)).toBe(1);
});

test("Esc with a paste's preview open closes the preview, and the turn goes on", async () => {
  const { server } = await running();
  const block = Array.from({ length: 50 }, (_, k) => `line ${k}`).join("\n");
  fireEvent.paste(box(), { clipboardData: { files: [], getData: () => block } });
  fireEvent.click(within(await screen.findByTestId("pasted-chip")).getByRole("button", { name: /show it/ }));
  expect(screen.getByTestId("paste-preview")).toBeTruthy();
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(screen.queryByTestId("paste-preview")).toBeNull();
  expect(aborts(server.sent)).toBe(0);
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(aborts(server.sent)).toBe(1);
});

test("Enter in an empty composer stops the running turn; with text it sends, and Shift+Enter is a new line", async () => {
  const { server } = await running();
  fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
  fireEvent.keyDown(box(), { isComposing: true, key: "Enter" });
  expect(aborts(server.sent)).toBe(0);
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(aborts(server.sent)).toBe(1);
  type("one more thing");
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(aborts(server.sent)).toBe(1);
  expect(server.sent.at(-1)).toContain("one more thing");
  // and the hint says Esc stops
  expect(screen.getByTestId("composer-hint").textContent).toContain("Esc stops");
});

test("Enter, Enter: the second press of an Enter that sent stops nothing; a second later, Enter is Stop again", async () => {
  const now = Date.parse("2026-10-20T10:00:00Z");
  setSystemTime(now);
  const { server } = await running();
  type("also check the tests");
  fireEvent.keyDown(box(), { key: "Enter" });
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(server.sent.filter((f) => f.includes("also check the tests"))).toHaveLength(1);
  expect(aborts(server.sent)).toBe(0);
  act(() => {
    setSystemTime(now + ENTER_AFTER_SEND_MS + 1);
  });
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(aborts(server.sent)).toBe(1);
});

test("on a touch screen Enter in an empty composer is a new line there, and stops nothing", async () => {
  await onTouchScreen(async () => {
    const { server } = await running();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(aborts(server.sent)).toBe(0);
  });
});

test("Enter in an empty composer with no turn running sends nothing and stops nothing", async () => {
  const { server } = start();
  await screen.findByText("what is in the repo?");
  const before = server.sent.length;
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(server.sent.length).toBe(before);
});

const key = (o: Partial<KeyLike>): KeyLike => ({ altKey: false, ctrlKey: false, defaultPrevented: false, isComposing: false, key: "Escape", keyCode: 27, metaKey: false, repeat: false, shiftKey: false, target: document.body, ...o });

test("the rule itself: Escape alone, taken by nothing and owned by nothing that has focus", () => {
  expect(escapeStops(key({}))).toBe(true);
  expect(escapeStops(key({ defaultPrevented: true }))).toBe(false); // a component took it
  expect(escapeStops(key({ key: "Enter" }))).toBe(false);
  expect(escapeStops(key({ metaKey: true }))).toBe(false);
  const select = document.createElement("select");
  document.body.append(select);
  expect(escapeStops(key({ target: select }))).toBe(false); // a native select closes its list
  select.remove();
});
