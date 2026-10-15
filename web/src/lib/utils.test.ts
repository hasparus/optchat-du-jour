// cn from shadcn's `cn` package, taught the theme's own sizes and shadows (utils.ts)
import { describe, expect, test } from "bun:test";
import { build } from "cn/build";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import config from "../../cn.config.mjs";
import { twMerge } from "./tw-compat";
import { cn } from "./utils";

const web = new URL("../..", import.meta.url).pathname;

// the names index.css's @theme blocks give a scale (`--text-ui`, not `--text-ui--line-height`)
// that Tailwind's own theme doesn't have, so a merge must be told them
const TAILWIND = { radius: ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"], text: ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"] };
const themed = (scale: "radius" | "text") => {
  const css = readFileSync(`${web}src/index.css`, "utf8");
  const names = [...css.matchAll(new RegExp(`^\\s*--${scale}-([a-z0-9]+):`, "gm"))].map((m) => m[1] ?? "");
  return [...new Set(names)].filter((n) => !TAILWIND[scale].includes(n)).toSorted();
};

describe("cn", () => {
  test("its tables are what `bun run cn-tables` writes from cn.config.mjs now", async () => {
    const dir = mkdtempSync(`${tmpdir()}/cn-tables-`);
    try {
      const fresh = await build({ config: "cn.config.mjs", css: false, cwd: web, full: true, out: `${dir}/cn-tables.ts` });
      expect(fresh.source).toBe(readFileSync(`${web}src/lib/cn-tables.ts`, "utf8"));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("cn.config.mjs names every text size and radius index.css's @theme adds", () => {
    expect(themed("text")).toEqual(["2xs", "read", "ui"]);
    expect(themed("radius")).toEqual(["glass"]);
    expect(config.extend.theme.text.toSorted()).toEqual(themed("text"));
    expect(config.extend.theme.radius.toSorted()).toEqual(themed("radius"));
  });

  test("Streamdown's twMerge (tailwind-merge, aliased to tw-compat.ts) merges on the same tables, theme included", () => {
    expect(twMerge("text-sm", "text-ui")).toBe("text-ui");
    expect(twMerge("rounded-xl", "rounded-glass")).toBe("rounded-glass");
    expect(twMerge("px-2", "px-4")).toBe("px-4");
  });

  test("joins like clsx: strings, conditions, arrays and objects", () => {
    expect(cn("a", false, null, undefined, ["b", { c: true, d: false }])).toBe("a b c");
  });

  test("a later Tailwind class wins over an earlier one of its group", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("text-muted-foreground", "text-destructive")).toBe("text-destructive");
  });

  test("the theme's own sizes are sizes, not colours", () => {
    expect(cn("text-sm", "text-ui")).toBe("text-ui");
    expect(cn("text-ui", "text-read")).toBe("text-read");
    expect(cn("text-xs", "text-2xs")).toBe("text-2xs");
    // a size and a colour stand side by side
    expect(cn("text-ui", "text-muted-foreground")).toBe("text-ui text-muted-foreground");
  });

  test("the glass radius is a radius: the sheets' and the composer's corners win over the Drawer's", () => {
    expect(cn("rounded-xl", "rounded-glass")).toBe("rounded-glass");
    expect(cn("data-[vaul-drawer-direction=bottom]:rounded-t-xl", "data-[vaul-drawer-direction=bottom]:rounded-t-glass")).toBe("data-[vaul-drawer-direction=bottom]:rounded-t-glass");
    expect(cn("rounded-glass", "rounded-t-none")).toBe("rounded-glass rounded-t-none");
  });

  test("the shadows and hairlines replace one another", () => {
    expect(cn("shadow-md", "shadow-float")).toBe("shadow-float");
    expect(cn("hairline", "shadow-lift")).toBe("shadow-lift");
    expect(cn("shadow-float", "hairline-strong")).toBe("hairline-strong");
  });
});
