// The page's look: light or dark, and which proposed design direction (UI audit, "variants"). Both
// are set on <html> before the first paint by index.html's inline script, from localStorage and
// `?variant=a|b|c` (`?variant=` clears it); this module changes them later and keeps the browser's
// own chrome (the PWA status bar, `theme-color`) the colour of the page.

export const VARIANTS = [
  { id: "", label: "Default" },
  { id: "a", label: "A · Transcript" },
  { id: "b", label: "B · Ledger" },
  { id: "c", label: "C · Pocket" },
] as const;
export type Variant = (typeof VARIANTS)[number]["id"];

const isVariant = (v: string | null | undefined): v is Variant => VARIANTS.some((x) => x.id === v);

export const currentVariant = (): Variant => {
  const v = document.documentElement.dataset.variant;
  return isVariant(v) ? v : "";
};

// the page's background as an sRGB hex, whatever colour space the token is written in
function pageColor(): string | null {
  const bg = getComputedStyle(document.body).backgroundColor;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// the status bar and the task switcher follow the page, light or dark, in every variant
export function syncThemeColor() {
  try {
    const color = pageColor();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (color && meta) meta.setAttribute("content", color);
  } catch {
    // no canvas (a test's DOM): the manifest's colour stays
  }
}

export function applyVariant(v: Variant) {
  if (v === "") delete document.documentElement.dataset.variant;
  else document.documentElement.dataset.variant = v;
  try {
    if (v === "") localStorage.removeItem("variant");
    else localStorage.setItem("variant", v);
  } catch {
    // no storage: the choice lasts this page
  }
  syncThemeColor();
}
