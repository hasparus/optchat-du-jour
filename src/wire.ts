// The contract between optchat-server and its clients (SPEC "Server, WebSocket API and CLI",
// "Protocol"): the session state the AG-UI events carry, the JSON of /api/*, and the small rules
// both sides read the log by. Pure schemas and helpers with no node imports, so the web UI bundles
// this same file instead of restating it.
import { Schema } from "effect";
import { Kind, Msg } from "./records.ts";

export { Kind, Msg } from "./records.ts";

// ---------------------------------------------------------------------------------------------
// the session's shared state (STATE_SNAPSHOT, STATE_DELTA)

// "needs-model": a turn stopped on a usage limit or an offline device, waiting for a client to
// pick an engine (`stopped` says which stopped it, and why)
export const Phase = Schema.Literals(["idle", "running", "waiting", "needs-model"]);
export type Phase = typeof Phase.Type;

// an engine of the compactor's chains that is down right now, and why
export const Down = Schema.Struct({ ref: Schema.String, reason: Schema.String });
export type Down = typeof Down.Type;

// What a message sent while a turn runs does (SPEC "Turn and priming", follow-ups): "steer" offers
// it to the running call, "queue" holds it for the next turn. The session has one setting, and a
// message may ask for the other ("send now" while queueing, "queue" while steering).
export const FollowUp = Schema.Literals(["steer", "queue"]);
export type FollowUp = typeof FollowUp.Type;

// An engine of the master's chain, for the composer's picker: its ref, a name for people
// (`engineLabel`), and why it can't take a turn now (it hit a usage limit: signed out, no key, a
// spent plan or budget), or null
export const MasterEngine = Schema.Struct({ ref: Schema.String, label: Schema.String, down: Schema.NullOr(Schema.String) });
export type MasterEngine = typeof MasterEngine.Type;

const capital = (w: string) => (w === "" ? w : `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`);
// a model id as people say it: "opus" Claude Opus, "claude-opus-5-5" Claude Opus 5.5, "gpt-6.1-sol" GPT-6.1 Sol
const modelName = (id: string) => {
  if (/^(opus|sonnet|haiku)$/.test(id)) return `Claude ${capital(id)}`;
  const claude = /^claude-([a-z]+)(?:-(\d+)(?:-(\d+))?)?$/.exec(id);
  if (claude?.[1]) return `Claude ${capital(claude[1])}${claude[2] ? ` ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}` : ""}`;
  const gpt = /^gpt-(?:([\d.]+)(?:-|$))?(.*)$/.exec(id);
  if (gpt) return [`GPT${gpt[1] ? `-${gpt[1]}` : ""}`, ...(gpt[2] ?? "").split("-").filter((w) => w !== "").map(capital)].join(" ");
  return id;
};
// an engine ref ("engine:model", src/config.ts) as the picker shows it: "Claude Opus (Claude Code)",
// "GPT-6.1 Sol (ChatGPT plan)", "Claude Opus 5.5 (Anthropic API key)"
export const engineLabel = (ref: string) => {
  const [engine = "", model = ""] = ref.split(/:(.*)/s);
  if (engine === "api-key") {
    const [, provider = "", id = model] = /^(anthropic|openai)\/(.+)$/.exec(model) ?? [];
    return `${modelName(id)} (${provider === "openai" ? "OpenAI" : "Anthropic"} API key)`;
  }
  const where = engine === "claude-code" ? "Claude Code" : engine === "openai-plan" ? "ChatGPT plan" : engine;
  return `${modelName(model)} (${where})`;
};

export const SessionState = Schema.Struct({
  phase: Phase,
  device: Schema.String, // where the next or current turn runs
  engine: Schema.NullOr(Schema.String), // the engine of the current turn
  waiting: Schema.Number, // view lines not summarized yet
  viewBytes: Schema.Number,
  budget: Schema.Number, // the view's high mark (VIEW_HIGH): past it, a batch folds it to VIEW_LOW
  messages: Schema.Number,
  // Every message the server holds and has not logged: waiting for a turn or for summaries, or
  // offered to the running call and not taken yet. `clientId`: the id its client sent it with;
  // `text`: as typed; `queued`: held for a later turn, so it can still be taken back; `media`: its
  // attachments as stored, when it has any.
  pending: Schema.Array(
    Schema.Struct({ clientId: Schema.NullOr(Schema.String), text: Schema.String, queued: Schema.Boolean, media: Schema.optional(Schema.Array(Schema.suspend(() => Asset))) }),
  ),
  down: Schema.Array(Down), // compactor engines down right now, with why (SPEC "Policy": never unseen)
  followUp: FollowUp, // what a message sent mid-run does, unless it asks otherwise
  // the engines the master may run on, in the configured order, and `lead`, the one turns run on
  // (the user's pick; the first unless picked). The master never fails over by itself (E4).
  engines: Schema.Array(MasterEngine),
  lead: Schema.String,
  stopped: Schema.NullOr(Schema.Struct({ ref: Schema.String, label: Schema.String, why: Schema.String })),
});
export type SessionState = typeof SessionState.Type;

// ---------------------------------------------------------------------------------------------
// how log entries map to AG-UI messages (SPEC "Protocol"): a message id is the entry's log index,
// a tool call's id is `t<index>` of its tool entry

// a tool entry is "<name> <json input>" (ref §5.3)
export const splitTool = (text: string) => {
  const space = text.indexOf(" ");
  return space === -1 ? { args: "", name: text } : { args: text.slice(space + 1), name: text.slice(0, space) };
};
// splitTool's inverse, for a tool call that came as a name and its arguments
export const joinTool = (name: string, args: string) => (args === "" ? name : `${name} ${args}`);
export const toolCallId = (i: number) => `t${i}`;

// a message id or tool call id back to its log index; null for an id that isn't one
export const logIndex = (id: string): number | null => {
  const digits = /^t?(\d+)$/.exec(id)?.[1];
  return digits === undefined ? null : Number(digits);
};

// gist §3 "Addressing": node (l, i) covers the messages [i·2^l, (i+1)·2^l), named `id+n`
export const span = ({ l, i }: { readonly l: number; readonly i: number }) => {
  const n = 2 ** l;
  return { id: i * n, n };
};

// ---------------------------------------------------------------------------------------------
// /api/*

// /api/messages: log entries (records.ts Msg, with the size the server adds), oldest first
export const MessagesPage = Schema.Struct({ entries: Schema.Array(Msg), total: Schema.Number });
export type MessagesPage = typeof MessagesPage.Type;

// /api/view: each view line with its range, dates and size
export const ViewLine = Schema.Struct({
  built: Schema.Boolean,
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  id: Schema.Number,
  n: Schema.Number,
  l: Schema.Number,
  i: Schema.Number,
  size: Schema.NullOr(Schema.Number),
  text: Schema.String,
});
export type ViewLine = typeof ViewLine.Type;

// `text`: the view rendered as the model gets it
// `budget`: the high mark, as in SessionState
export const View = Schema.Struct({ budget: Schema.Number, lines: Schema.Array(ViewLine), size: Schema.Number, text: Schema.String });
export type View = typeof View.Type;

// /api/node: a message (level 0), or a node and its two children
export const NodeView = Schema.Union([
  Schema.Struct({ l: Schema.Literal(0), i: Schema.Number, id: Schema.Number, n: Schema.Number, kind: Kind, text: Schema.String, date: Schema.String }),
  Schema.Struct({
    l: Schema.Number,
    i: Schema.Number,
    id: Schema.Number,
    n: Schema.Number,
    text: Schema.NullOr(Schema.String),
    children: Schema.Array(Schema.Struct({ built: Schema.Boolean, l: Schema.Number, i: Schema.Number, text: Schema.NullOr(Schema.String) })),
  }),
]);
export type NodeView = typeof NodeView.Type;

// /api/devices: each configured device; `local`, the server's own machine; `refused`, a runner that
// is up but answered 403 (its callers or the server's node name are misconfigured)
export const Device = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  folders: Schema.Array(Schema.String),
  local: Schema.Boolean,
  status: Schema.Literals(["online", "offline", "refused"]),
  claudeVersion: Schema.NullOr(Schema.String),
});
export type Device = typeof Device.Type;
export const Devices = Schema.Array(Device);

// /api/usage: usage.jsonl, one record per model call (E11)
export const Role = Schema.Literals(["turn", "prime", "compact", "subagent", "caption"]);
export const Engine = Schema.Literals(["claude-code", "openai-plan", "api-key"]);
export const Auth = Schema.Literals(["claude-max", "chatgpt-pro", "api-key"]);

export const Tokens = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type Tokens = typeof Tokens.Type;

export const UsageRecord = Schema.Struct({
  date: Schema.String,
  role: Role,
  engine: Engine,
  auth: Auth,
  model: Schema.NullOr(Schema.String),
  device: Schema.NullOr(Schema.String),
  level: Schema.NullOr(Schema.Number),
  usage: Tokens,
  cold: Schema.Boolean,
  attempt: Schema.Number,
  // the engine this call took over from: the link before it in a compactor's or caption's chain
  // (a failover), or for a turn, the engine a usage limit or an offline device stopped before the
  // user picked this one (E4); null for a first call
  failoverFrom: Schema.NullOr(Schema.String),
  ms: Schema.Number,
  dollars: Schema.optional(Schema.Number),
});
export type UsageRecord = typeof UsageRecord.Type;
export const Usage = Schema.Array(UsageRecord);

// ---------------------------------------------------------------------------------------------
// media (SPEC "Media"): what PUT /api/assets answers, and the marker lines a message with
// attachments carries in the log

export const ImageMime = Schema.Literals(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const VideoMime = Schema.Literals(["video/mp4", "video/quicktime", "video/webm"]);

// a stored image: the normalized one (downscaled, re-encoded, metadata stripped), which is what
// every engine and zoom get
export const ImageAsset = Schema.Struct({
  kind: Schema.Literal("image"),
  sha: Schema.String,
  mime: ImageMime,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  // a high-detail image past 2000 px also keeps the standard-tier one (its own image asset): what a
  // request with many images is sent instead, and zoom's answer (src/media/budget.ts)
  small: Schema.optionalKey(Schema.String),
});
export type ImageAsset = typeof ImageAsset.Type;

// a frame of a video, `t` seconds in; itself an image asset
export const Frame = Schema.Struct({ sha: Schema.String, t: Schema.Number, width: Schema.Number, height: Schema.Number });
export type Frame = typeof Frame.Type;

// A stored video: the upload as it came, its frames (at most 24, one per 2 s or spread over a
// longer clip), `sheet` (one image of the frames, what a thumbnail and zoom show), and the audio's
// transcript when a local whisper made one; `notice` says why something is missing.
export const VideoAsset = Schema.Struct({
  kind: Schema.Literal("video"),
  sha: Schema.String,
  mime: VideoMime,
  bytes: Schema.Number,
  duration: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  frames: Schema.Array(Frame),
  sheet: Schema.String,
  transcript: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
export type VideoAsset = typeof VideoAsset.Type;

export const Asset = Schema.Union([ImageAsset, VideoAsset]);
export type Asset = typeof Asset.Type;

// attachments per message: each is one marker line, and the line must stay well inside a node
export const MAX_ATTACHMENTS = 4;
// a caption's size in UTF-8 bytes, at most; the marker grammar forbids brackets and newlines in it
export const CAPTION_MAX = 120;
export const NOT_DESCRIBED = "(not described)";

// what a marker and a thumbnail name an asset by
export const shortSha = (sha: string) => sha.slice(0, 12);

// the UTF-8 size of one code point
const bytesOf = (cp: number) => (cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65_536 ? 3 : 4);

// the longest start of `text` that is at most `max` bytes, cut between code points; `whole` says it was not cut
const startOf = (text: string, max: number) => {
  let size = 0;
  let start = "";
  for (const ch of text) {
    size += bytesOf(ch.codePointAt(0) ?? 0);
    if (size > max) return { start, whole: false };
    start += ch;
  }
  return { start, whole: true };
};

// one line of at most CAPTION_MAX bytes with no brackets, so it can't end its marker early. A
// longer one is cut between code points, never inside a surrogate pair, and ends in "…" (3 bytes).
export const cleanCaption = (text: string) => {
  const flat = text.replaceAll(/\s+/g, " ").replaceAll("[", "(").replaceAll("]", ")").trim();
  if (flat === "") return NOT_DESCRIBED;
  const whole = startOf(flat, CAPTION_MAX);
  return whole.whole ? flat : `${startOf(flat, CAPTION_MAX - 3).start}…`;
};

// [image 9d0c38e7aafe 1568x1176 212KB: a whiteboard with three arrows]
// [video 9d0c38e7aafe 47s, 24 frames: a cat jumping onto a desk]
export const markerOf = (a: Asset, caption: string) => {
  const what = a.kind === "image" ? `${a.width}x${a.height} ${Math.max(1, Math.round(a.bytes / 1024))}KB` : `${Math.round(a.duration)}s, ${a.frames.length} frames`;
  return `[${a.kind} ${shortSha(a.sha)} ${what}: ${cleanCaption(caption)}]`;
};

const MARKER = /^\[(image|video) ([0-9a-f]{12}) [^\]\n:]*: [^\]\n]*\]$/;
export type Marker = { readonly kind: "image" | "video"; readonly sha: string; readonly line: string };
export type Marked = { readonly body: string; readonly markers: readonly Marker[] };

// A user entry's text: what was typed, then one marker line per attachment. Only marker lines at
// the end count; one typed in the middle of a message is text.
export const splitMarkers = (text: string): Marked => {
  const lines = text.split("\n");
  const markers: Marker[] = [];
  while (lines.length > 0) {
    const line = lines.at(-1) ?? "";
    const m = MARKER.exec(line);
    if (!m?.[1] || !m[2]) break;
    markers.unshift({ kind: m[1] === "video" ? "video" : "image", line, sha: m[2] });
    lines.pop();
  }
  return { body: lines.join("\n"), markers };
};

// splitMarkers' inverse: the text as typed (none when it is blank), then the marker lines
export const withMarkers = (body: string, markers: readonly string[]) =>
  markers.length === 0 ? body : body.trim() === "" ? markers.join("\n") : `${body}\n${markers.join("\n")}`;
