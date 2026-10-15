// shadcn's class joiner: later Tailwind classes win over earlier ones. tailwind-merge learns the
// theme's own font sizes (index.css: text-2xs, text-ui, text-read), so `text-ui` replaces `text-sm`
// rather than standing beside it as if it were a colour, and the shadows and hairlines replace one
// another.
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: { shadow: ["shadow-float", "shadow-lift", "hairline", "hairline-strong"] },
    theme: { text: ["2xs", "ui", "read"] },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
