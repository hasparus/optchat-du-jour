// What the app tells the page it shows, and what it takes back. Before the page's scripts run it
// defines window.optchatShell (web/src/lib/shell.ts reads it), whose changeServer posts the one
// message the app answers. bridge.test.ts runs the script against web/src/lib/shell.ts.
import { sameOrigin } from "./server-url";

// the global, as web/src/lib/shell.ts names it
export const SHELL_GLOBAL = "optchatShell";

// the one message the page sends, exactly as the shell's changeServer posts it
export const CHANGE_SERVER = JSON.stringify({ type: "change-server" });

// the script that runs before the page's own (injectedJavaScriptBeforeContentLoaded, main frame
// only); it ends in true, as react-native-webview asks of injected scripts
export const shellScript = `window[${JSON.stringify(SHELL_GLOBAL)}] = Object.freeze({
  changeServer: function () {
    window.ReactNativeWebView.postMessage(${JSON.stringify(CHANGE_SERVER)});
  },
});
true;`;

// A message from a page asks for the server screen only when it is that message and the page that
// sent it is the server's own: react-native-webview hands every frame the same postMessage, and
// says which page's URL a message came from.
export const asksForServerScreen = (origin: string, message: { readonly url: string; readonly data: string }): boolean =>
  message.data === CHANGE_SERVER && sameOrigin(origin, message.url);
