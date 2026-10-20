// From fx0 lib/design-md.ts (Apache-2.0, © Vercel, modified). The ten most-installed DESIGN.md
// files on getdesign.md, as fx0 picked them (install counts read on 2026-10-05). The files in
// prompts/design-md/ are VoltAgent/awesome-design-md at 13be5c0, unmodified (MIT, see
// prompts/design-md/LICENSE). They are analyses of each brand's public website, not files the
// brands publish themselves.
//
// fx0 put the chosen file into the system prompt of a chat started with it. Ours is one endless
// chat whose system prompt is part of every cached prefix, so a 25-40 KB style can't sit there:
// the master reads one when asked for it, as read_artifact("style/<id>") (SPEC "Artifacts"), and
// the tool's description names the ids, so "in the style of Linear" needs no lookup first.
import { readFileSync } from "node:fs";

export type StyleOption = { readonly id: string; readonly name: string; readonly description: string };

// the descriptions are the style half of getdesign.md's own one-line summaries
export const STYLES: readonly StyleOption[] = [
  { description: "Premium white space, SF Pro, cinematic imagery.", id: "apple", name: "Apple" },
  { description: "Warm terracotta accent, clean editorial layout.", id: "claude", name: "Claude" },
  { description: "Black and white precision, Geist font.", id: "vercel", name: "Vercel" },
  { description: "Warm minimalism, serif headings, soft surfaces.", id: "notion", name: "Notion" },
  { description: "Warm coral accent, photography-driven, rounded UI.", id: "airbnb", name: "Airbnb" },
  { description: "Ultra-minimal, precise, purple accent.", id: "linear.app", name: "Linear" },
  { description: "Signature purple gradients, weight-300 elegance.", id: "stripe", name: "Stripe" },
  { description: "Vibrant multi-color, playful yet professional.", id: "figma", name: "Figma" },
  { description: "Pure black canvas, M tricolor stripe accents, full-bleed photography.", id: "bmw-m", name: "BMW M" },
  { description: "Clean blue identity, trust-focused, institutional feel.", id: "coinbase", name: "Coinbase" },
];

// read_artifact's name for a style: "style/" and its id
export const STYLE_PREFIX = "style/";

// A style's DESIGN.md by its id or its name in any case ("linear", "Linear", "linear.app"); null
// for one that isn't among them. Read from the repo on each call: they are only read when asked.
export const readStyle = (asked: string): { readonly option: StyleOption; readonly text: string } | null => {
  const key = asked.toLowerCase();
  const option = STYLES.find((s) => s.id === key || s.name.toLowerCase() === key || s.id.split(".")[0] === key);
  if (!option) return null;
  return { option, text: readFileSync(`${import.meta.dir}/../../prompts/design-md/${option.id}.md`, "utf8") };
};
