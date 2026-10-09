// The iOS app (mobile/, README "On your phone") is a WebView on this page as the server serves it.
// Before any script here runs it defines `optchatShell` on window: what the page may ask of the
// app. In a browser or the PWA there is none, and nothing that uses it shows. mobile/src/bridge.ts
// writes it; mobile/src/bridge.test.ts runs that script and reads it back through this module, so
// the two can't drift.

export type Shell = {
  readonly platform: string;
  readonly version: string;
  // back to the app's own screen for the server's address
  readonly changeServer: () => void;
};

declare global {
  // defined by the iOS app only
  // oxlint-disable-next-line no-var -- a global the app defines is declared with var
  var optchatShell: Shell | undefined;
}

// the global the app defines, and the event it fires on window when it comes back to the foreground
export const SHELL_GLOBAL = "optchatShell";
export const WAKE_EVENT = "optchat:wake";

export type ShellHost = { readonly optchatShell?: Shell | undefined };

// the app's shell, if this page is in one
export const nativeShell = (host: ShellHost = globalThis): Shell | undefined => host.optchatShell;
