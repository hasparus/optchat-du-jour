// What the composer keeps across a reload, or a phone browser evicting the tab (SPEC "Web UI",
// Chat): the draft (the text and the attachments already uploaded, as their asset descriptors),
// the messages sent from here that no ack has answered yet, and this client's sent texts for Up
// to recall. All of it lives in this browser's localStorage only; every access may throw (a
// private window, storage turned off or full), and then the page works as before, keeping nothing.
import { Asset } from "@wire";
import { Option, Schema } from "effect";

const DRAFT = "optchat:draft";
const SENT = "optchat:sent";
const HISTORY = "optchat:history";
// sent texts kept for recall, the newest last
export const HISTORY_MAX = 50;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // no storage: kept for this page only
  }
};
// a stored value that no longer decodes (an older page wrote it) counts as none
const load = <A, I>(key: string, schema: Schema.Codec<A, I>): A | null =>
  Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(read(key) ?? ""));

export const Draft = Schema.Struct({ text: Schema.String, media: Schema.Array(Asset) });
export type Draft = typeof Draft.Type;

export const loadDraft = (): Draft | null => load(DRAFT, Draft);
// an empty draft is no draft
export const saveDraft = (d: Draft) => {
  write(DRAFT, d.text === "" && d.media.length === 0 ? null : JSON.stringify(d));
};

// A message sent from here, kept until its ack says it is logged: after a reload the session store
// finds it in the log, in the server's queue, or neither ("it may not have reached the server").
// Kept per tab (its id in sessionStorage, which a reload or a restored tab keeps), so two tabs
// never overwrite each other's; a list a closed tab left is dropped after a week.
export const Sent = Schema.Struct({ id: Schema.String, text: Schema.String, media: Schema.Array(Asset), from: Schema.Number });
export type Sent = typeof Sent.Type;
const Kept = Schema.Struct({ at: Schema.Number, sent: Schema.Array(Sent) });
const WEEK = 7 * 24 * 3600 * 1000;

// this tab's id: kept across its reloads; a fresh one per page where sessionStorage can't be used
const tab = (() => {
  try {
    const id = sessionStorage.getItem("optchat:tab") ?? crypto.randomUUID();
    sessionStorage.setItem("optchat:tab", id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();
export const sentKey = `${SENT}:${tab}`;

// other tabs' lists older than a week: their tabs are gone
const prune = () => {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, k) => localStorage.key(k) ?? "");
    for (const key of keys) {
      if (!key.startsWith(`${SENT}:`) || key === sentKey) continue;
      const kept = load(key, Kept);
      if (kept === null || Date.now() - kept.at > WEEK) localStorage.removeItem(key);
    }
  } catch {
    // no storage: nothing kept to prune
  }
};

export const loadSent = (): readonly Sent[] => {
  prune();
  return load(sentKey, Kept)?.sent ?? [];
};
export const saveSent = (sent: readonly Sent[]) => {
  write(sentKey, sent.length === 0 ? null : JSON.stringify({ at: Date.now(), sent }));
};

export const loadHistory = (): readonly string[] => load(HISTORY, Schema.Array(Schema.String)) ?? [];
// a text sent: the newest entry, once (sending the same text again moves it to the end)
export const remember = (text: string) => {
  if (text.trim() === "") return;
  const kept = loadHistory().filter((t) => t !== text);
  write(HISTORY, JSON.stringify([...kept, text].slice(-HISTORY_MAX)));
};
