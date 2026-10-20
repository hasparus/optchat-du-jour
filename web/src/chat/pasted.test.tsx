// Long pastes, folded (lib/paste.ts, ./pasted.tsx): in the composer a paste past the threshold is a
// token and a chip that opens and can be removed, a short one is plain text; the message sent is
// exactly what was typed and pasted; in the chat the sent message shows the block folded, and opens it.
import { expect, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { loadDraft } from "@/lib/draft";
import { box, lastId, sentTexts, start, stubApi, type } from "@/test/app";
import { ack, said } from "@/test/fixture";

stubApi();

const LOG_LINES = Array.from({ length: 120 }, (_, k) => `2026-10-20 10:00:${String(k % 60).padStart(2, "0")} worker: step ${k}`).join("\n");

// a paste of `text` over the composer's selection [from, to)
const paste = (text: string, from: number, to = from) => {
  const el = box();
  el.setSelectionRange(from, to);
  fireEvent.paste(el, { clipboardData: { files: [], getData: (kind: string) => (kind === "text/plain" ? text : "") } });
};

test("a long paste is a token in the text and a chip; it opens, and the message sent has it where it was pasted", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  type("why does this fail?\n\nthanks");
  paste(LOG_LINES.replaceAll("\n", "\r\n"), "why does this fail?\n".length);
  expect(box().value).toBe("why does this fail?\n[Pasted text #1, 120 lines]\nthanks");
  const chip = await screen.findByTestId("pasted-chip");
  expect(chip.textContent).toContain("120 lines");
  // the draft keeps the block, for a reload
  expect(loadDraft()?.pastes?.map((p) => p.text)).toEqual([LOG_LINES]);
  // opened: the block, as it will be sent (its line ends the textarea's own)
  fireEvent.click(within(chip).getByRole("button", { name: /Pasted text #1.*show it/ }));
  expect(screen.getByTestId("paste-preview").textContent).toBe(LOG_LINES);
  // a short paste is text, as ever
  paste("short", box().value.length);
  expect(box().value.endsWith("thanks")).toBe(true); // happy-dom inserts nothing itself: not folded, not ours
  fireEvent.keyDown(box(), { key: "Enter" });
  const whole = `why does this fail?\n${LOG_LINES}\nthanks`;
  expect(sentTexts(server.sent).map((m) => m.text)).toEqual([whole]);
  expect(screen.queryByTestId("pasted-chip")).toBeNull();

  // logged: the bubble folds the block, keeps what was typed, and opens it in place
  play(ack(lastId(server.sent), 4), ...said(4, "user", whole));
  const fold = await screen.findByTestId("pasted-fold");
  const bubble = fold.closest('[data-testid="user-message"]');
  expect(bubble?.textContent).toContain("why does this fail?");
  expect(bubble?.textContent).toContain("thanks");
  const toggle = within(fold).getByRole("button", { name: /Pasted text/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(fold.textContent).toContain("worker: step 119");
});

test("removing the chip takes its token out of the text; typing over the token drops the chip", async () => {
  start();
  await screen.findByText("what is in the repo?");
  type("see ");
  paste("x".repeat(5000), 4);
  expect(box().value).toBe("see [Pasted text #1, 4.9 KB]");
  fireEvent.click(screen.getByRole("button", { name: "Remove pasted text #1" }));
  expect(box().value).toBe("see ");
  expect(screen.queryByTestId("pasted-chip")).toBeNull();

  paste(LOG_LINES, 4);
  await screen.findByTestId("pasted-chip");
  act(() => {
    type("see [Pasted text #2, 120 lin");
  });
  expect(screen.queryByTestId("pasted-chip")).toBeNull();
});

test("a long message from another client folds whole; a short one doesn't fold", async () => {
  start([
    { kind: "user", text: LOG_LINES },
    { kind: "user", text: "just this" },
  ]);
  const fold = await screen.findByTestId("pasted-fold");
  expect(within(fold).getByRole("button").textContent).toContain("Long message");
  expect(within(fold).getByRole("button").textContent).toContain("120 lines");
  expect(screen.getAllByTestId("pasted-fold")).toHaveLength(1);
  expect(screen.getByText("just this")).toBeTruthy();
});
