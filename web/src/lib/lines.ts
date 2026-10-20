// A text's lines as a reader counts them: a final newline ends the last line rather than starting
// another, and an empty text has none. The one splitter of the paste folds (./paste.ts) and the
// file diffs (./diff.ts).
export const linesOf = (text: string): string[] => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));
