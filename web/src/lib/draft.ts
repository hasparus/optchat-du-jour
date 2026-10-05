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
export const Sent = Schema.Struct({ id: Schema.String, text: Schema.String, media: Schema.Array(Asset), from: Schema.Number });
export type Sent = typeof Sent.Type;

export const loadSent = (): readonly Sent[] => load(SENT, Schema.Array(Sent)) ?? [];
export const saveSent = (sent: readonly Sent[]) => {
  write(SENT, sent.length === 0 ? null : JSON.stringify(sent));
};

export const loadHistory = (): readonly string[] => load(HISTORY, Schema.Array(Schema.String)) ?? [];
// a text sent: the newest entry, once (sending the same text again moves it to the end)
export const remember = (text: string) => {
  if (text.trim() === "") return;
  const kept = loadHistory().filter((t) => t !== text);
  write(HISTORY, JSON.stringify([...kept, text].slice(-HISTORY_MAX)));
};
