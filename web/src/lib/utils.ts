// shadcn's class joiner, from shadcn's `cn` package (clsx and tailwind-merge in one, with the same
// output): later Tailwind classes win over earlier ones. Its tables are compiled by `cn build`
// (`bun run cn-tables`) into cn-tables.ts with every class group kept, so they never depend on
// which classes the sources use, plus the theme's own classes from cn.config.mjs: the font sizes
// (text-2xs, text-ui, text-read), so `text-ui` replaces `text-sm` rather than standing beside it
// as if it were a colour, and the shadows and hairlines, which replace one another. Compiled
// ahead, the theme costs nothing at run time, where `cn/config`'s createCn would bring its
// compiler into the bundle (12.6 kB gzipped). utils.test.ts checks the tables are current.
import { createCn } from "cn/engine";
import tables from "./cn-tables.ts";

export type { ClassValue } from "cn";

export const cn = createCn(tables);
