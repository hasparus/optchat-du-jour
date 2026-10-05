// The Worker Grep runs in (see grep-search.ts): one job in, the lines out, or the error's message.
import { type GrepJob, searchFiles } from "./grep-search.ts";

declare const self: Worker;

self.addEventListener("message", (event: MessageEvent<GrepJob>) => {
  try {
    postMessage({ lines: searchFiles(event.data) });
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
