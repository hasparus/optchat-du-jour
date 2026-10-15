// tailwind-merge's API on our own `cn` engine, for the packages that still import tailwind-merge
// (Streamdown): vite.config.ts aliases `tailwind-merge` here, so their merges use the same tables
// as ours (cn-tables.ts, with the theme's classes) and the bundle carries one set of tables, not
// `cn`'s default ones as well. clsx and twJoin are the engine's own; `clsx` itself is aliased to
// `cn/engine`.
import { createEngine } from "cn/engine";
import tables from "./cn-tables.ts";

export { clsx, twJoin } from "cn/engine";

// the one engine: utils.ts builds cn on it too
export const engine = createEngine(tables);
export const twMerge = engine.merge;
