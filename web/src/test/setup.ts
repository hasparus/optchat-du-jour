// bun test's DOM (happy-dom) and testing-library's cleanup between tests.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

GlobalRegistrator.register({ url: "http://127.0.0.1:7700/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  localStorage.clear(); // a draft or an unacked message one test kept is not the next one's
});

// No test reaches a real server: a request to the page's own origin that a test didn't stub (the
// session store asks /api/reasoning after every snapshot) is answered 404, as by a server without
// the route, instead of a refused connection.
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    return url.origin === location.origin ? new Response(null, { status: 404 }) : realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);
