// The theme's own classes for shadcn's `cn` (src/lib/utils.ts): the font sizes index.css's @theme
// declares (text-2xs, text-ui, text-read) are sizes, and the float and lift shadows and the
// hairline utilities (box-shadows too) replace a shadow and one another. `bun run cn-tables`
// compiles this into src/lib/cn-tables.ts. Named here rather than read from index.css: cn 0.4.0's
// stylesheet reader takes the `/*` in `@source "…/dist/*.js"` for a comment and misses the
// @theme block after it.
export default {
  extend: {
    classGroups: { shadow: ["shadow-float", "shadow-lift", "hairline", "hairline-strong"] },
    theme: { text: ["2xs", "ui", "read"] },
  },
};
