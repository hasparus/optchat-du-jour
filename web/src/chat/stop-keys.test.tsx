// Esc, and Enter in an empty composer, stop the running turn as Stop does (lib/stop-keys.ts,
// ./use-stop-keys.ts); not while an input method composes, a dialog or a menu is open, or the
// artifact pane has focus; not when no turn runs; and Enter with something typed still sends.
import { expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { escapeStops, type KeyLike } from "@/lib/stop-keys";
import { box, start, stubApi, type } from "@/test/app";
import { state } from "@/test/fixture";

stubApi();

const ABORT = '{"type":"abort"}';
const aborts = (sent: readonly string[]) => sent.filter((f) => f === ABORT).length;

const running = async () => {
  const app = start();
  await screen.findByText("what is in the repo?");
  app.play(state({ engine: "claude-code:opus", phase: "running" }));
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

test("Esc is left to an input method that composes, an open dialog or menu, and the artifact pane", async () => {
  const { server } = await running();
  fireEvent.keyDown(box(), { isComposing: true, key: "Escape" });
  fireEvent.keyDown(box(), { key: "Escape", keyCode: 229 });
  // Background work, a sheet: its Escape closes it
  fireEvent.click(within(screen.getByTestId("status")).getByRole("button"));
  const sheet = await screen.findByRole("dialog", { name: "Background work" });
  fireEvent.keyDown(document.activeElement ?? sheet, { key: "Escape" });
  expect(aborts(server.sent)).toBe(0);
  fireEvent.animationEnd(sheet);
  await within(document.body).findByRole("button", { name: "Stop" });

  // what owns its keys, and a menu over the chat, drawn here as the pane and the Model Selector draw theirs
  const pane = document.createElement("div");
  pane.dataset.keys = "own";
  const field = document.createElement("input");
  pane.append(field);
  document.body.append(pane);
  fireEvent.keyDown(field, { key: "Escape" });
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(aborts(server.sent)).toBe(0);
  pane.remove();
  menu.remove();
  fireEvent.keyDown(document.body, { key: "Escape" });
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

test("Enter in an empty composer with no turn running sends nothing and stops nothing", async () => {
  const { server } = start();
  await screen.findByText("what is in the repo?");
  const before = server.sent.length;
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(server.sent.length).toBe(before);
});

const key = (o: Partial<KeyLike>): KeyLike => ({ altKey: false, ctrlKey: false, defaultPrevented: false, isComposing: false, key: "Escape", keyCode: 27, metaKey: false, repeat: false, shiftKey: false, target: document.body, ...o });

test("the rule itself: Escape alone, with nothing over the page and nothing that owns the key", () => {
  expect(escapeStops(key({}), document)).toBe(true);
  expect(escapeStops(key({ defaultPrevented: true }), document)).toBe(false); // a component took it
  expect(escapeStops(key({ key: "Enter" }), document)).toBe(false);
  expect(escapeStops(key({ metaKey: true }), document)).toBe(false);
  const select = document.createElement("select");
  document.body.append(select);
  expect(escapeStops(key({ target: select }), document)).toBe(false); // a native select closes its list
  select.remove();
});
