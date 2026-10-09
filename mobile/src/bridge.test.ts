// The app's injected script against the web UI's reader of it (web/src/lib/shell.ts): the name
// they share, a page that asks for the server screen posts exactly the message the app answers,
// and the app answers it only from the server's own page.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import * as web from "../../web/src/lib/shell";
import { asksForServerScreen, CHANGE_SERVER, SHELL_GLOBAL, shellScript } from "./bridge";

const ORIGIN = "https://mini.tailnet.ts.net";

// the page's window as the WebView gives it: react-native-webview's postMessage
type Page = web.ShellHost & { readonly ReactNativeWebView: { readonly postMessage: (data: string) => void } };

const page = () => {
  const posted: string[] = [];
  const window: Page = {
    ReactNativeWebView: {
      postMessage: (data) => {
        posted.push(data);
      },
    },
  };
  // what the script evaluates to: react-native-webview wants true
  const run = (script: string): boolean => runInNewContext(script, { window }) === true;
  return { posted, run, window };
};

test("the app and the web UI name the global alike", () => {
  expect(SHELL_GLOBAL).toBe(web.SHELL_GLOBAL);
});

test("the shell script defines a shell the web UI reads, whose changeServer posts the message the app acts on", () => {
  const p = page();
  expect(web.nativeShell(p.window)).toBeUndefined();
  expect(p.run(shellScript)).toBe(true);
  web.nativeShell(p.window)?.changeServer();
  expect(p.posted).toEqual([CHANGE_SERVER]);
  expect(asksForServerScreen(ORIGIN, { data: p.posted[0] ?? "", url: `${ORIGIN}/` })).toBe(true);
});

test("the app answers the message only from the server's own page, and nothing else from it", () => {
  for (const url of ["https://evil.example/", "https://mini.tailnet.ts.net:8443/", "http://mini.tailnet.ts.net/", "about:blank", "about:srcdoc", ""]) {
    expect(asksForServerScreen(ORIGIN, { data: CHANGE_SERVER, url })).toBe(false);
  }
  for (const data of ["", "change-server", "{}", '{"type":"reload"}', '{"type": "change-server"}']) {
    expect(asksForServerScreen(ORIGIN, { data, url: `${ORIGIN}/` })).toBe(false);
  }
});
