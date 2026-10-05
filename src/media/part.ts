// A piece of a user message as an engine sends it (SPEC "Media"): text, or an image's bytes. The
// log holds text only; images reach a model only on the turn that sends them, and through zoom.
export type Picture = { readonly type: "image"; readonly mime: string; readonly data: string }; // data: base64
export type Part = string | Picture;

export const isPicture = (p: Part): p is Picture => typeof p !== "string";
export const textOnly = (parts: readonly Part[]) => parts.filter((p): p is string => typeof p === "string");
