// The dock's word on the turn and the link (./turn-status.tsx): "Busy, asking again in N s" while
// the turn's engine waits to ask again, counting down from the state and gone when the state drops
// it (E43); and "OptChat was updated" with a reload once the server closes the link as from
// another build, instead of reconnecting (E44).
import { expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { WIRE_STALE } from "@wire";
import { start, stubApi } from "@/test/app";
import { state } from "@/test/fixture";
import { secondsLeft } from "./turn-status";

stubApi();

test("while the turn's engine waits to ask again, the status says so and counts down; then it is the status again", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(state({ engine: "claude-code:opus", phase: "running" }));
  const status = await screen.findByTestId("status");
  expect(within(status).queryByTestId("retry-countdown")).toBeNull();
  play(state({ retry: { ms: 3000, next: 2, tries: 4 } }));
  const countdown = within(status).getByTestId("retry-countdown");
  expect(countdown.textContent).toBe("Busy, asking again in 3 s");
  expect(countdown.getAttribute("title")).toBe("Try 2 of 4");
  await waitFor(
    () => {
      expect(within(status).getByTestId("retry-countdown").textContent).toBe("Busy, asking again in 2 s");
    },
    { timeout: 2500 },
  );
  // the next try started: the state no longer says it waits
  play(state({ retry: null }));
  await waitFor(() => {
    expect(within(screen.getByTestId("status")).queryByTestId("retry-countdown")).toBeNull();
  });
  expect(screen.getByTestId("status").textContent).toContain("running on mini");
});

test("the seconds left count from when this page got the state, and stop at none", () => {
  const retry = { ms: 5000, next: 2, tries: 4 };
  expect(secondsLeft(retry, 1000, 1000)).toBe(5);
  expect(secondsLeft(retry, 1000, 2001)).toBe(4);
  expect(secondsLeft(retry, 1000, 9000)).toBe(0);
});

test("a server of another build: the link stays down, and the tray says OptChat was updated, with a reload", async () => {
  const { server } = start();
  await screen.findByText("what is in the repo?");
  act(() => {
    server.sockets[0]?.close(WIRE_STALE);
  });
  const banner = await screen.findByTestId("outdated");
  expect(banner.textContent).toContain("OptChat was updated — reload");
  expect(within(banner).getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(screen.queryByTestId("status")).toBeNull(); // not "reconnecting…"
  await Bun.sleep(50); // a reconnect would have opened by now
  expect(server.sockets).toHaveLength(1);
  expect(screen.getByRole("img", { name: "connection outdated" }).getAttribute("title")).toBe("OptChat was updated: reload");
});
