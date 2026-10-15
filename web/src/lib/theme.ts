// The page's theme: light or dark, set on <html> before the first paint by index.html's inline
// script (the saved choice, else the system's); the header's toggle changes it later. This module
// keeps the browser's own chrome (the PWA status bar, `theme-color`) the colour of the page.

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
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
  // nothing painted (a canvas that draws nothing, or a background it could not parse): no colour
  // rather than a black status bar
  if (a === 0) return null;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// the status bar and the task switcher follow the page, light or dark
export function syncThemeColor() {
  try {
    const color = pageColor();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (color && meta) meta.setAttribute("content", color);
  } catch {
    // no canvas (a test's DOM): the manifest's colour stays
  }
}
