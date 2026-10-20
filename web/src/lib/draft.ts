// What the composer keeps across a reload, or a phone browser evicting the tab (SPEC "Web UI",
// Chat): the draft (the text and the attachments already uploaded, as their asset descriptors),
// the messages sent from here that no ack has answered yet, this client's sent texts for Up to
// recall, the model its picker is on, and where the long pastes were in the messages it sent
// (lib/paste.ts), so they show folded. All of it lives in this browser's localStorage only; every access may throw (a
// private window, storage turned off or full), and then the page works as before, keeping nothing.
import { Asset, FollowUp } from "@wire";
import { Option, Schema } from "effect";

const DRAFT = "optchat:draft";
const SENT = "optchat:sent";
const HISTORY = "optchat:history";
const MODEL = "optchat:model";
const FOLDS = "optchat:folds";
// messages sent from here whose pasted blocks are remembered, the newest last
export const FOLDS_MAX = 50;
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

// where a long paste is in a message's text, [start, end) (lib/paste.ts Span)
const Span = Schema.Tuple([Schema.Number, Schema.Number]);

// `pastes`: the long blocks folded into the text's tokens (lib/paste.ts); a draft from before them has none
const Paste = Schema.Struct({ id: Schema.Number, text: Schema.String });
export const Draft = Schema.Struct({ text: Schema.String, media: Schema.Array(Asset), pastes: Schema.optional(Schema.Array(Paste)) });
export type Draft = typeof Draft.Type;

export const loadDraft = (): Draft | null => load(DRAFT, Draft);
// an empty draft is no draft
export const saveDraft = (d: Draft) => {
  write(DRAFT, d.text === "" && d.media.length === 0 ? null : JSON.stringify(d));
};

// Where the pasted blocks are in the messages sent from here (lib/paste.ts expand), by the log index
// the server's ack gave each, for the chat to fold just those; none for a message with none, which
// then never folds. The newest FOLDS_MAX messages, oldest first.
// Each with the length of the message's text, so a log index that now names another message (the
// server's log was started afresh) folds nothing of it (lib/paste.ts foldsOf).
const Fold = Schema.Struct({ length: Schema.Number, spans: Schema.Array(Span) });
export type Fold = typeof Fold.Type;
const Folds = Schema.Array(Schema.Struct({ i: Schema.Number, fold: Fold }));
export type Folds = ReadonlyMap<number, Fold>;
export const loadFolds = (): Folds => new Map((load(FOLDS, Folds) ?? []).map((f) => [f.i, f.fold]));
// the message logged at `i` had these pasted blocks: the folds as they are now
export const rememberFolds = (folds: Folds, i: number, fold: Fold): Folds => {
  const kept = [...folds].filter(([at]) => at !== i).map(([at, f]) => ({ fold: f, i: at }));
  const next = [...kept, { fold, i }].slice(-FOLDS_MAX);
  write(FOLDS, JSON.stringify(next));
  return new Map(next.map((f) => [f.i, f.fold]));
};

// A message sent from here, kept until its ack says it is logged: after a reload the session store
// sends it again under its id, and the server answers what became of it (E41), with the device,
// engine and follow-up it first went with. One a page from before E41 kept (it has `from`, the
// log's length when it was sent) is only marked: it may be logged already, by a server that kept
// no ids. Kept per tab (its id in sessionStorage, which a reload or a restored tab keeps), so two
// tabs never overwrite each other's; a list a closed tab left is dropped after a week.
export const Sent = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  media: Schema.Array(Asset),
  device: Schema.optional(Schema.String),
  engine: Schema.optional(Schema.String),
  followUp: Schema.optional(FollowUp),
  from: Schema.optional(Schema.Number),
  // where its long pastes are in `text` (lib/paste.ts), none when it had none
  spans: Schema.optional(Schema.Array(Span)),
});
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

// The model picker's engine (a ref of the master's chain): this client's own, never the server's.
// Null when none was picked here; the composer then shows the chain's first.
export const loadModel = (): string | null => read(MODEL);
export const saveModel = (ref: string) => {
  write(MODEL, ref);
};
