// cn from shadcn's `cn` package, taught the theme's own sizes and shadows (utils.ts)
import { describe, expect, test } from "bun:test";
import { build } from "cn/build";
import { readFileSync } from "node:fs";
import { cn } from "./utils";

const web = new URL("../..", import.meta.url).pathname;

describe("cn", () => {
  test("its tables are what `bun run cn-tables` writes from cn.config.mjs now", async () => {
    const fresh = await build({ config: "cn.config.mjs", css: false, cwd: web, full: true, out: "node_modules/.cache/cn-tables.ts" });
    expect(fresh.source).toBe(readFileSync(`${web}src/lib/cn-tables.ts`, "utf8"));
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

  test("the shadows and hairlines replace one another", () => {
    expect(cn("shadow-md", "shadow-float")).toBe("shadow-float");
    expect(cn("hairline", "shadow-lift")).toBe("shadow-lift");
    expect(cn("shadow-float", "hairline-strong")).toBe("hairline-strong");
  });
});
