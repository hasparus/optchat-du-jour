// The app's injected scripts against the web UI's reader of them (web/src/lib/shell.ts): the names
// they share, and a page that asks for the server screen posts exactly the message the app answers.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import * as web from "../../web/src/lib/shell";
import { CHANGE_SERVER, SHELL_GLOBAL, shellScript, WAKE_EVENT, wakeScript } from "./bridge";

// the page's window as the WebView gives it: react-native-webview's postMessage, and events
type Page = web.ShellHost & {
  readonly dispatchEvent: (event: Event) => boolean;
  readonly ReactNativeWebView: { readonly postMessage: (data: string) => void };
};

const page = () => {
  const posted: string[] = [];
  const fired: string[] = [];
  const window: Page = {
    dispatchEvent: (event) => {
      fired.push(event.type);
      return true;
    },
    ReactNativeWebView: {
      postMessage: (data) => {
        posted.push(data);
      },
    },
  };
  // what the script evaluates to: react-native-webview wants true
  const run = (script: string): boolean => runInNewContext(script, { Event, window }) === true;
  return { fired, posted, run, window };
};

test("the app and the web UI name the global and the wake event alike", () => {
  expect(SHELL_GLOBAL).toBe(web.SHELL_GLOBAL);
  expect(WAKE_EVENT).toBe(web.WAKE_EVENT);
});

test("the shell script defines a shell the web UI reads, whose changeServer posts the message the app acts on", () => {
  const p = page();
  expect(p.run(shellScript("0.1.0"))).toBe(true);
  const shell = web.nativeShell(p.window);
  expect(shell).toMatchObject({ platform: "ios", version: "0.1.0" });
  shell?.changeServer();
  expect(p.posted).toEqual([CHANGE_SERVER]);
});

test("the wake script fires the event the web UI listens for", () => {
  const p = page();
  expect(p.run(wakeScript)).toBe(true);
  expect(p.fired).toEqual([web.WAKE_EVENT]);
});

test("in a browser the web UI finds no shell", () => {
  expect(web.nativeShell({})).toBeUndefined();
});
