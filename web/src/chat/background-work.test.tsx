import { afterEach, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openLink } from "@/lib/connection";
import { makeSession } from "@/lib/session";
import { fakeServer, IDLE, snapshot } from "@/test/fixture";
import { BackgroundWork, Group } from "./background-work";

const links: { readonly close: () => void }[] = [];
afterEach(() => {
  cleanup();
  for (const l of links.splice(0)) l.close();
});

const devices = {
  data: [],
  error: null,
  reload: () => null,
};

const sheet = async (groups: Pick<ComponentProps<typeof BackgroundWork>, "extra"> = {}) => {
  const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  links.push(link);
  render(
    <TooltipProvider>
      <BackgroundWork
        {...groups}
        devices={devices}
        link={link}
        onOpenChange={() => {
          // keep the fixture sheet open
        }}
        open
        session={makeSession(link)}
      />
    </TooltipProvider>,
  );
  return screen.findByRole("dialog", { name: "Background work" });
};

test("an absent group list still says nothing is running", async () => {
  expect(within(await sheet()).getByText(/Nothing is running/)).toBeTruthy();
});

test("an empty group list still says nothing is running", async () => {
  expect(within(await sheet({ extra: [] })).getByText(/Nothing is running/)).toBeTruthy();
});

for (const names of [["scout"], ["scout", "builder"]]) {
  test(`${names.length} extra groups render without the empty state`, async () => {
    const open = await sheet({
      extra: names.map((name) => (
        <Group count={1} icon={null} key={name} title={name}>
          <div data-testid={`work-${name}`}>{name} running</div>
        </Group>
      )),
    });
    for (const name of names) expect(within(open).getByTestId(`work-${name}`)).toBeTruthy();
    expect(within(open).queryByText(/Nothing is running/)).toBeNull();
  });
}
