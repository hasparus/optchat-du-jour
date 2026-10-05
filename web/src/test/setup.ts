// bun test's DOM (happy-dom) and testing-library's cleanup between tests.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

GlobalRegistrator.register({ url: "http://127.0.0.1:7700/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
});
