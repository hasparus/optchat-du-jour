import { expect, test } from "bun:test";

import { lint, SENTINEL, SENTINEL_RULE } from "./fixture.js";

/**
 * A glob one star too wide silences a rule in every consumer repo and says
 * nothing. So these run the binary over real paths and read the rule ids back.
 */

/** Sources chosen so the rule under test is the only other one that can fire. */
const DEFAULT_EXPORT = `${SENTINEL}export default function Thing() {\n  return 1;\n}\n`;
const INNER_TEXT = `${SENTINEL}export const read = (el) => el.innerText;\n`;

test("import/no-default-export is off for Next's file conventions and on elsewhere", () => {
  const found = lint([
    ["app/page.tsx", DEFAULT_EXPORT],
    ["app/blog/[slug]/page.tsx", DEFAULT_EXPORT],
    ["app/forbidden.tsx", DEFAULT_EXPORT],
    ["app/opengraph-image2.tsx", DEFAULT_EXPORT],
    ["src/app/layout.tsx", DEFAULT_EXPORT],
    ["apps/web/app/page.tsx", DEFAULT_EXPORT],

    // Route handlers export GET/POST by name, so the rule still applies.
    ["app/api/users/route.ts", DEFAULT_EXPORT],
    // Only the image routes take a numeric suffix; there is no `page1`.
    ["app/page1.tsx", DEFAULT_EXPORT],
    ["app/layout99.tsx", DEFAULT_EXPORT],
    // An `app` directory deeper than the anchors reach.
    ["src/lib/app/error.ts", DEFAULT_EXPORT],
    // The React convention of grouping page components — not Next's `pages`.
    ["src/components/pages/HomePage.tsx", DEFAULT_EXPORT],
    ["packages/ui/pages/Button.tsx", DEFAULT_EXPORT],
    // Pages Router is not claimed: no filename to narrow on.
    ["pages/index.tsx", DEFAULT_EXPORT],
    ["src/utils/thing.ts", DEFAULT_EXPORT],
  ]);

  const off = (path: string) => {
    expect(found[path], `${path} was never linted`).toContain(SENTINEL_RULE);
    expect(found[path]).not.toContain("import/no-default-export");
  };
  const on = (path: string) => {
    expect(found[path]).toContain("import/no-default-export");
  };

  off("app/page.tsx");
  off("app/blog/[slug]/page.tsx");
  off("app/forbidden.tsx");
  off("app/opengraph-image2.tsx");
  off("src/app/layout.tsx");
  off("apps/web/app/page.tsx");

  on("app/api/users/route.ts");
  on("app/page1.tsx");
  on("app/layout99.tsx");
  on("src/components/pages/HomePage.tsx");
  on("packages/ui/pages/Button.tsx");
  on("pages/index.tsx");
  on("src/utils/thing.ts");

  // Residual of the `**` prefix: the filename is the only thing narrowing it.
  off("src/lib/app/error.ts");
});

test("agent tooling directories are ignored, at the root and further down", () => {
  const found = lint([
    [".claude/hooks/stop.ts", SENTINEL],
    [".cursor/rules/thing.ts", SENTINEL],
    ["packages/ui/.claude/skills/x/run.ts", SENTINEL],

    // A directory whose name merely starts the same way is somebody's source.
    ["src/claude/client.ts", SENTINEL],
    ["src/thing.ts", SENTINEL],
  ]);

  // Ignored and clean both report nothing; only the sentinel tells them apart.
  expect(found[".claude/hooks/stop.ts"]).toEqual([]);
  expect(found[".cursor/rules/thing.ts"]).toEqual([]);
  expect(found["packages/ui/.claude/skills/x/run.ts"]).toEqual([]);

  expect(found["src/claude/client.ts"]).toContain(SENTINEL_RULE);
  expect(found["src/thing.ts"]).toContain(SENTINEL_RULE);
});

test("unicorn/prefer-dom-node-text-content is off for Playwright specs only", () => {
  const found = lint([
    ["e2e/cart.spec.ts", INNER_TEXT],
    ["apps/web/e2e/cart.spec.ts", INNER_TEXT],
    ["playwright/cart.test.ts", INNER_TEXT],
    ["src/e2e/checkout.spec.ts", INNER_TEXT],

    // Real DOM code that happens to live beside the specs.
    ["e2e/helpers/dom.ts", INNER_TEXT],
    ["src/components/Thing.ts", INNER_TEXT],
  ]);

  const rule = "unicorn/prefer-dom-node-text-content";

  const off = (path: string) => {
    expect(found[path], `${path} was never linted`).toContain(SENTINEL_RULE);
    expect(found[path]).not.toContain(rule);
  };

  off("e2e/cart.spec.ts");
  off("apps/web/e2e/cart.spec.ts");
  off("playwright/cart.test.ts");
  // Not anchored: an `e2e` directory at any depth counts.
  off("src/e2e/checkout.spec.ts");

  expect(found["e2e/helpers/dom.ts"]).toContain(rule);
  expect(found["src/components/Thing.ts"]).toContain(rule);
});
