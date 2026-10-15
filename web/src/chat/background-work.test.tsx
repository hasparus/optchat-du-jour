// Background work's empty state with M7's `extra` slot: whatever React draws nothing for (undefined,
// null, false) is no group, so the sheet still says nothing runs; a group in it is something
import { afterEach, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openLink } from "@/lib/connection";
import { makeSession } from "@/lib/session";
import { fakeServer, IDLE, snapshot } from "@/test/fixture";
import { BackgroundWork } from "./background-work";

const links: { readonly close: () => void }[] = [];
afterEach(() => {
  cleanup();
  for (const l of links.splice(0)) l.close();
});

const devices = {
  data: [],
  error: null,
  reload: () => {
    // no devices here
  },
};

const sheet = async (extra: ReactNode) => {
  const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  links.push(link);
  render(
    <TooltipProvider>
      <BackgroundWork
        devices={devices}
        extra={extra}
        link={link}
        onOpenChange={() => {
          // stays open
        }}
        open
        session={makeSession(link)}
      />
    </TooltipProvider>,
  );
  return screen.findByRole("dialog", { name: "Background work" });
};

for (const [name, extra] of [
  ["undefined", undefined],
  ["null", null],
  ["false", false],
] as const) {
  test(`an empty slot (${name}) still says nothing is running`, async () => {
    expect(within(await sheet(extra)).getByText(/Nothing is running/)).toBeTruthy();
  });
}

test("a group in the slot is something: no empty state", async () => {
  const open = await sheet(<div data-testid="work-subagent">scout</div>);
  expect(within(open).getByTestId("work-subagent")).toBeTruthy();
  expect(within(open).queryByText(/Nothing is running/)).toBeNull();
});
