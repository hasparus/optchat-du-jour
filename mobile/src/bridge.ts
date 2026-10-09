// What the app tells the page it shows, and what it takes back. Before the page's scripts run it
// defines window.optchatShell (web/src/lib/shell.ts reads it): the app's platform and version, and
// changeServer, which posts the one message the app answers. On every return to the foreground it
// fires optchat:wake, so a dropped /ws link retries at once. bridge.test.ts runs these scripts
// against web/src/lib/shell.ts.

// the global and the event, as web/src/lib/shell.ts names them
export const SHELL_GLOBAL = "optchatShell";
export const WAKE_EVENT = "optchat:wake";

// the one message the page sends, exactly as the shell's changeServer posts it
export const CHANGE_SERVER = JSON.stringify({ type: "change-server" });

// the script that runs before the page's own (injectedJavaScriptBeforeContentLoaded); it ends in
// true, as react-native-webview asks of injected scripts
export function shellScript(version: string): string {
  const shell = `{
    platform: "ios",
    version: ${JSON.stringify(version)},
    changeServer: function () {
      window.ReactNativeWebView.postMessage(${JSON.stringify(CHANGE_SERVER)});
    },
  }`;
  return `window[${JSON.stringify(SHELL_GLOBAL)}] = Object.freeze(${shell});\ntrue;`;
}

export const wakeScript = `window.dispatchEvent(new Event(${JSON.stringify(WAKE_EVENT)}));\ntrue;`;
