// The constants of docs/optchat.md and of its earlier revision (SPEC "Constants and configuration") and the reference's timings (ref §2, §7). Sizes are UTF-8
// bytes. Everything that may differ per machine is in optchat.config.ts instead.
import { Array as Arr, Data, Effect, Result, Schema, SchemaGetter, SchemaIssue, SchemaTransformation } from "effect";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Endpoints } from "./openai/endpoints.ts";
import { Engine } from "./usage.ts";
import { canonicalRef, effortSplit, engineLabel, FollowUp } from "./wire.ts";

// a summary line's target size, and the most a free node may hold
export const NODE = 512;
// The view's sawtooth (docs/optchat.md §3.2): each message appends its line, and once the view
// passes VIEW_HIGH one batch of merges takes it down to VIEW_LOW
export const VIEW_HIGH = 128_000;
export const VIEW_LOW = 64_000;
// The compaction view's (docs/optchat.md §4 "Its view"): the chat's view merged further, on a
// sawtooth of its own from COMPACTION_HIGH down to COMPACTION_LOW
export const COMPACTION_HIGH = 32_000;
export const COMPACTION_LOW = 16_000;
// compactor calls at once (docs/optchat.md §4 "The order")
export const JOBS = 8;
// a message's node starts once fewer than AHEAD view lines before it are unbuilt (ibid.)
export const AHEAD = 8;
// tries per node to get a summary under NODE; a failed call is tried again at the next message
export const TRIES = 5;
// while a turn waits for summaries, a failed call is also tried again this often (E24): no message
// comes to try it again then, and a fixed pause never delays the turn by more than itself
export const WAIT_RETRY = "10 seconds";
// A node whose call the model refused, or answered with an empty line, this many times is built
// from its source clipped to NODE bytes, marked so it can be rebuilt (E33). A refusal is the
// input's doing, so asking again mostly fails alike (UniiChat clips at the first); one more try,
// WAIT_RETRY later, lets a flaky safeguard pass, and holds a waiting turn back by that much at most.
export const REFUSALS = 2;
// A failed compactor call rests WAIT_RETRY before a logged entry, or the pump by itself, tries it
// again; each failure in a row doubles that, up to REST_MOST (E33). A message coming to the
// session, or a turn waiting for summaries, tries it at once all the same.
export const REST_MOST = "5 minutes";
// The /ws heartbeat (UniiChat's values): the server sends a connection the state when nothing else
// went out for HEARTBEAT, and a client that hears nothing for SILENT takes the socket for dead and
// opens another. A half-open TCP connection or a laptop on a new Wi-Fi otherwise looks open for
// minutes. SILENT lives with the client (web/src/lib/connection.ts), which can't import this file.
export const HEARTBEAT = "5 seconds";
// A MESSAGES_SNAPSHOT frame on /ws holds at most this many bytes of the log's window, its newest
// entries; a client reads the rest from /api/messages (E42). A frame can't be cut into, by the
// heartbeat or anything else, so this bounds how long one keeps a link busy: 128 KiB is about 10 s
// (SILENT) at 100 kbit/s, and a slower link has the client's growing window. A window of 200
// entries of 600 bytes each still fits whole, and then no page is read (test/paging.test.ts).
export const SNAPSHOT_BYTES = 128 * 1024;
// A CUSTOM `memory` frame on /ws (E47), what changed in the view's lines, holds the new lines
// themselves only while it stays under this many bytes; past it a change says where and how many,
// and a client that shows them reads them from /api/memory/view. A message's line, or one that
// filled in, is about a kilobyte, so the usual frame carries it; a batch that merged far apart
// may not. 16 KiB is about 1.3 s at 100 kbit/s.
export const MEMORY_BYTES = 16 * 1024;
// The ids of client actions other than messages the server remembers answering (E41), the newest
// first; a message's id is the session's to remember (src/once.ts).
export const ACTS = 1000;
// Our own HTTP engines (api-key, openai-plan; E35): one request that fails on the vendor's side (a
// 408, 409, 429, 5xx or 529, a dropped connection, a stream gone quiet) is sent again up to this
// many tries in all, after a doubling pause from HTTP_RETRY_BASE with jitter, or the server's
// `retry-after`, before the failure reaches the failover chain. A `retry-after` longer than
// HTTP_RETRY_LONGEST is a limit, not a hiccup: the chain moves on at once.
export const HTTP_TRIES = 4;
export const HTTP_RETRY_BASE = "1 second";
export const HTTP_RETRY_LONGEST = "60 seconds";
// A stream with no bytes for this long is dead (UniiChat's values): Anthropic pings while the
// model thinks, the Responses API can stay quiet through a long reasoning
export const IDLE_ANTHROPIC = "5 minutes";
export const IDLE_OPENAI = "20 minutes";
// The most `media.captionWait` may be, in ms (SPEC "Media"): how long a message, and the turn it
// starts, waits for its attachments' captions before it is logged without them. The default, 10 s,
// is a few times what one picture's caption takes once claude is up; a minute leaves room for a
// slow caption chain (a cold start, a later link). Longer, a turn that hasn't started reads as
// hung, and the server's stop waits longer too: it still awaits a caption asked for before it began.
export const CAPTION_WAIT_MOST = 60_000;
// the most characters of one tool result that get logged
export const CAP = 30_000;
// The most characters of one message a compaction reads (E49): its head and its tail, half each,
// with a line between them that says how much was cut and which zoom reads it. CAP plus room for
// cap()'s own cut line, so a tool's output, capped when it was logged, is read whole as before;
// a pasted log, a long reply or a long tool call past it costs a compaction what a capped tool
// output does (about 8,000 tokens a try, sent again with each size retry) instead of growing with
// it. UniiChat logs a long text in pages of CAP; we log it whole (E23), so the bound goes here.
export const LEAF = 32_000;
// lines per content block of the view, or of a compactor's context (docs/optchat.md §3.3 "How the
// cache is marked"): one cache mark on the last whole block
export const BLOCK = 4;
// the blocks a vendor looks back from a mark for an entry an earlier request wrote (docs/optchat.md
// §3.3, Anthropic's): single flight waits only on a prefix within it (E50)
export const LOOKBACK = 20;
// The longest a call waits on another writing its prefix (E50); past it the writer's claim lapses
// and the waiter writes instead. A request is taken within seconds (priming gets PRIME_TIMEOUT for
// it); a writer still without its first response event after this is in a long retry pause or
// hung, and its CALL_TIMEOUT is minutes away.
export const FLIGHT_WAIT = "30 seconds";

export const CALL_TIMEOUT = "5 minutes";
export const KILL_GRACE = "5 seconds";
export const PRIME_TIMEOUT = "30 seconds";
export const PRIME_IDLE = "1 second";
// warm claude processes (E18): one kept this long at most, then replaced; one that dies while
// idle is replaced after WARM_RETRY, at most WARM_TRIES times in a row
export const WARM_MAX_AGE = "30 minutes";
export const WARM_RETRY = "2 seconds";
export const WARM_TRIES = 3;
// an engine of the master's chain that hit a usage limit shows as down in the picker this long,
// unless it answers sooner; then it can be picked again
export const MASTER_DOWN_FOR = "30 minutes";
// requests one turn of our own tool loop may make (openai-plan, api-key); the last one may not
// call tools, so the turn ends with an answer (M5)
export const TOOL_ROUNDS = 40;
// what is kept of a turn's thinking in the reasoning side file (SPEC "Reasoning"): at most this
// many characters per piece (the thinking before one reply or tool call) and per turn, the head of
// each, in UTF-16 code units cut at a code-point boundary as CAP's are; what is left out is counted
export const REASONING_PIECE = 30_000;
export const REASONING_TURN = 120_000;
// Subagents (SPEC "Subagents", E36-E40): how many run at once unless `subagents.max` says; how long
// an idle master waits after a report for others before the reports wake it in one turn (E39); and
// where each device keeps the git worktrees of isolated subagents unless `subagents.worktrees` says
// (`~` is that device's home): outside every repository, so a repo's own tools never see them (E37)
export const SUBAGENTS_MAX = 4;
export const WAKE_DEBOUNCE = "2 seconds";
// woken master turns in a row with no user message between them before reports stop waking it
// (E39's fuse, unless `subagents.wakeLimit` says; 0: no limit): a master that spawns at every
// woken turn would otherwise run all night
export const WAKE_LIMIT = 8;
export const WORKTREES = "~/.optchat-worktrees";

// optchat.config.ts (SPEC "Constants and configuration"): engines, compactor chains per level,
// cache TTLs, devices, who may connect.

const Ttl = Schema.Literals(["1h", "5m"]);
// How claude reaches /mcp (E8). "ws" is a type Claude Code's config schema takes but does not
// document (probed on 2.1.289: it connects, with subprotocol "mcp" and no Origin); "http" is.
export const McpTransport = Schema.Literals(["ws", "http"]);
export type McpTransport = typeof McpTransport.Type;
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

// An engine of a chain (E4, E5), written "engine:model" ("claude-code:opus"), decoded once with the
// settings: the engine, the model it is given, and `ref`, which names the engine in notices, in the
// picker and in usage.jsonl's `failoverFrom` (a record has its engine, model and effort apart). An
// api-key ref names its provider too ("api-key:anthropic/claude-opus-5-5"), and `model` is that
// provider's model id. An entry may carry its own effort, as "claude-code:haiku@xhigh" or
// { ref: "claude-code:haiku", effort: "xhigh" }, where the role's `effort` is the default; `ref`
// then ends in "@xhigh" either way, so the same model at two efforts is two engines, unless that
// effort is the role's: then `ref` is the bare one (`atRoleEffort`), as the same engine. `model`
// never has the suffix.
const Model = { model: Schema.String, ref: Schema.String, effort: Schema.optional(Effort) };
const RefValue = Schema.Union([
  Schema.Struct({ engine: Schema.Literal("claude-code"), ...Model }),
  Schema.Struct({ engine: Schema.Literal("openai-plan"), ...Model }),
  Schema.Struct({ engine: Schema.Literal("api-key"), provider: Schema.Literals(["anthropic", "openai"]), ...Model }),
]);
export type Ref = typeof RefValue.Type;
// a ref whose engine runs on a provider (src/providers/): everything but claude-code, which runs its own loop
export type ProviderRef = Exclude<Ref, { readonly engine: "claude-code" }>;
export type ApiKeyRef = Extract<Ref, { readonly engine: "api-key" }>;

export const isEffort = Schema.is(Effort);

// The efforts a Claude model takes. Claude Code (2.1.295's model catalog) leaves an effort it can't
// use out of the request and the Messages API refuses it. Aliases (haiku, sonnet, opus) are the
// latest models and take all of them (haiku is Haiku 5.5, low to max); Claude 3, Opus 4.0 and 4.1,
// Sonnet 4.0 and 4.5 and Haiku 4.5 take none; Opus 4.6 and Sonnet 4.6 stop below xhigh, Opus 4.5
// at high. A model is read as its family: any case, a dated snapshot ("-20250514", Vertex's
// "@20250929"), a 1M-context variant ("[1m]"), a Bedrock id or inference profile
// ("anthropic.claude-opus-4-6-v1", "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0").
const claudeEfforts = (model: string): readonly Effort[] => {
  const id = model
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/[-@]\d{8}$/, "");
  if (/^claude-(3-|opus-4(-[01])?$|sonnet-4(-[05])?$|haiku-4-5$)/.test(id)) return [];
  if (id === "claude-opus-4-5") return ["low", "medium", "high"];
  if (/^claude-(opus-4-6|sonnet-4-6)$/.test(id)) return ["low", "medium", "high", "max"];
  return Effort.literals;
};
// the efforts an entry's model takes: a Claude model's (claude-code, api-key on Anthropic) as known;
// any other is given what it is configured with
const effortsOf = (r: { readonly engine: string; readonly model: string; readonly provider?: string }) =>
  r.engine === "claude-code" || (r.engine === "api-key" && r.provider === "anthropic") ? claudeEfforts(r.model) : Effort.literals;

// The effort an entry runs at: its own (one its model can't take is refused when the ref is read),
// else its role's when its model takes that, else the highest its model takes below the role's,
// else none: a model that takes no effort is sent none. The captions have no role's effort.
export const runEffort = (r: Ref, role: Effort | undefined): Effort | undefined => {
  if (r.effort !== undefined || role === undefined) return r.effort ?? role;
  const takes = effortsOf(r);
  return Effort.literals.slice(0, Effort.literals.indexOf(role) + 1).findLast((e) => takes.includes(e));
};

// an entry's own effort, refused when its model can't take it, with the ref as written
const withEffortTaken = (r: Ref): Result.Result<Ref, string> => {
  const takes = effortsOf(r);
  if (r.effort === undefined || takes.includes(r.effort)) return Result.succeed(r);
  return Result.fail(`engine ${r.ref}: ${r.model} ${takes.length === 0 ? "takes no effort" : `has no ${r.effort} effort (it takes ${takes.join(", ")})`}`);
};

// "engine:model" or "engine:model@effort" (src/wire.ts effortSplit: the last "@" ends the model,
// unless a date follows it, as in Vertex's "claude-sonnet-4-5@20250929"). One effort at most, and
// one the model takes.
export const parseRef = (ref: string): Result.Result<Ref, string> => {
  const [bare, written] = effortSplit(ref);
  const withEffort = written === undefined ? {} : isEffort(written) ? { effort: written } : null;
  if (withEffort === null) return Result.fail(`engine ${ref}: ${written === "" ? "an empty effort" : `effort ${written}`} is not one of ${Effort.literals.join(", ")}`);
  const [engine = "", model = ""] = bare.split(/:(.*)/s);
  if (model === "") return Result.fail(`engine ${ref}: expected engine:model`);
  if (model.replace(/@\d{8}$/, "").includes("@")) return Result.fail(`engine ${ref}: one "@effort" at most, after the model`);
  if (engine === "claude-code" || engine === "openai-plan") return withEffortTaken({ engine, model, ref, ...withEffort });
  if (engine !== "api-key") return Result.fail(`engine ${ref}: no such engine (${Engine.literals.join(", ")})`);
  const [, provider, id] = /^(anthropic|openai)\/(.+)$/.exec(model) ?? [];
  if ((provider !== "anthropic" && provider !== "openai") || id === undefined) return Result.fail(`${ref} must be api-key:anthropic/<model> or api-key:openai/<model>`);
  return withEffortTaken({ engine, model: id, provider, ref, ...withEffort });
};

// the object form { ref, effort } is the same entry as "ref@effort"
const parseObject = (entry: { readonly ref: string; readonly effort: Effort }): Result.Result<Ref, string> => {
  const parsed = parseRef(entry.ref);
  if (Result.isFailure(parsed)) return parsed;
  if (parsed.success.effort !== undefined) return Result.fail(`engine ${entry.ref}: effort is given twice (in the ref and as ${entry.effort})`);
  return withEffortTaken({ ...parsed.success, effort: entry.effort, ref: `${entry.ref}@${entry.effort}` });
};

const decodedAs = <I>(parse: (written: I) => Result.Result<Ref, string>, encode: (r: Ref) => Effect.Effect<I, SchemaIssue.Issue>) =>
  SchemaTransformation.transformEffect<Ref, I>({
    decode: (written, options) =>
      Result.match(parse(written), {
        onFailure: (message) => Effect.fail(new SchemaIssue.InvalidValue({ message }, written, options)),
        onSuccess: Effect.succeed,
      }),
    encode,
  });
const EngineRef = Schema.Union([
  Schema.String.pipe(Schema.decodeTo(RefValue, decodedAs(parseRef, (r) => Effect.succeed(r.ref)))),
  // never encoded (the string form above encodes every Ref first), but decodeTo asks for an encoder
  Schema.Struct({ ref: Schema.String, effort: Effort }).pipe(Schema.decodeTo(RefValue, decodedAs(parseObject, (r) => Effect.fail(new SchemaIssue.InvalidValue({ message: `${r.ref} is written as a string` }, r))))),
]);
const Chain = Schema.NonEmptyArray(EngineRef);
// An entry at its role's effort is the bare ref: "claude-code:opus@high" in a chain at high is
// "claude-code:opus" (src/wire.ts canonicalRef), one engine under one ref, so the session, the
// picker and the duplicate check see them as one.
export const atRoleEffort = (chain: Arr.NonEmptyReadonlyArray<Ref>, effort: Effort) =>
  Arr.map(chain, (r): Ref => (r.effort === effort ? { ...r, effort: undefined, ref: canonicalRef(r.ref, effort) } : r));
// what the picker shows for an entry of a role: its ref, and the effort it runs at when that is
// not what the ref says (`runEffort`: a lower one, or none)
export const entryLabel = (r: Ref, role: Effort) => {
  const runs = runEffort(r, role);
  return engineLabel(r.ref, r.effort !== undefined || runs === role ? undefined : (runs ?? null));
};
// dollars per million tokens (SPEC "Usage and cost tracking"); cache writes per TTL, Anthropic only
const Price = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite5m: Schema.optional(Schema.Number),
  cacheWrite1h: Schema.optional(Schema.Number),
});
export type Price = typeof Price.Type;

// A chain names each engine once, known by what runs: its engine, its model and the effort it runs
// at (`runEffort`; `role` is the role's effort, none for the captions). So "x@xhigh" and
// { ref: "x", effort: "xhigh" } are one, so are "x@high" and "x" in a chain at high, and "x" and
// "x@high" in a chain at xhigh when x stops at high: each later one is refused.
export const duplicateRefs = (at: string, chain: readonly Ref[], role?: Effort) => {
  const seen = new Map<string, string>();
  return chain.flatMap((r) => {
    const runs = runEffort(r, role);
    const key = JSON.stringify([r.engine, r.engine === "api-key" ? r.provider : null, r.model, runs ?? null]);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, r.ref);
      return [];
    }
    const as = first === r.ref ? "" : `: it runs as ${first} does, at ${runs ?? "no effort"}`;
    return [`${at}: ${r.ref} is in the chain more than once${as} (an entry at its role's effort is its bare ref)`];
  });
};

export const Settings = Schema.Struct({
  master: Schema.Struct({
    chain: Chain,
    effort: Effort,
    permissionMode: Schema.String,
    tools: Schema.optional(Schema.Array(Schema.String)),
    // what a message sent while a turn runs does until a client chooses (SPEC "Turn and
    // priming"): "steer" (the default) offers it to the running call, "queue" holds it for the
    // next turn; a client's choice (`settings` over /ws) is kept in session.json and wins
    followUp: Schema.optional(FollowUp),
  }).pipe(Schema.decode({ decode: SchemaGetter.transform((m) => ({ ...m, chain: atRoleEffort(m.chain, m.effort) })), encode: SchemaGetter.passthrough() })),
  compactor: Schema.Struct({
    byLevel: Schema.NonEmptyArray(Schema.Struct({ from: Schema.Int, chain: Chain })),
    effort: Effort,
  }).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((c) => ({ ...c, byLevel: Arr.map(c.byLevel, (b) => ({ ...b, chain: atRoleEffort(b.chain, c.effort) })) })),
      encode: SchemaGetter.passthrough(),
    }),
  ),
  // claude-code's own TTLs (E6). An API key's requests have no setting: docs/optchat.md §3.3's lifetime, 5-minute
  // only (src/apikey/anthropic.ts). An older config's `apiKeyTtls` is dropped like any unknown key.
  cache: Schema.Struct({ claudeCodeTtl: Ttl, primeTtl: Ttl }),
  devices: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String, folders: Schema.Array(Schema.String) })),
  defaultDevice: Schema.String,
  allowedLogins: Schema.Array(Schema.String),
  // publicUrl: the server as the tailnet reaches it (`tailscale serve`), for claude on other devices;
  // mcpTransport: how claude reaches zoom and date, "ws" unless set (E8)
  server: Schema.optional(
    Schema.Struct({ host: Schema.String, port: Schema.Int, publicUrl: Schema.optional(Schema.String), mcpTransport: Schema.optional(McpTransport) }),
  ),
  // the api-key engine (overflow): a price per "provider/model" (e.g. "anthropic/claude-opus-5-5"),
  // the dollars it may spend per calendar month, and the API bases (tests point them at fakes)
  apiKey: Schema.optional(
    Schema.Struct({
      monthlyBudget: Schema.Number,
      prices: Schema.Record(Schema.String, Price),
      maxTokens: Schema.optional(Schema.Int),
      anthropicUrl: Schema.optional(Schema.String),
      openaiUrl: Schema.optional(Schema.String),
    }),
  ),
  // Media (SPEC "Media"): the caption chain, how long a message waits for its captions before it
  // is logged without them (ms, at most CAPTION_WAIT_MOST), upload limits, the ffmpeg tools for
  // video and how long each call may take (`toolSeconds`, on top of the clip's length), a local
  // whisper command (the WAV's path is appended; none: audio is not transcribed) with its own limit
  // (`whisperSeconds`, on top of the clip's length), and whether the ChatGPT
  // plan's route is sent images (not probed yet, so off unless set)
  media: Schema.optional(
    Schema.Struct({
      caption: Schema.optional(Chain),
      captionWait: Schema.optional(Schema.Number.check(Schema.isBetween({ maximum: CAPTION_WAIT_MOST, minimum: 0 }))),
      maxImageBytes: Schema.optional(Schema.Int),
      maxVideoBytes: Schema.optional(Schema.Int),
      maxVideoSeconds: Schema.optional(Schema.Number),
      toolSeconds: Schema.optional(Schema.Number),
      whisperSeconds: Schema.optional(Schema.Number),
      ffmpeg: Schema.optional(Schema.String),
      ffprobe: Schema.optional(Schema.String),
      whisper: Schema.optional(Schema.Array(Schema.String)),
      planImages: Schema.optional(Schema.Boolean),
    }),
  ),
  // A turn's thinking (SPEC "Reasoning"): `keep` writes it to the side file beside the log
  // (chat/reasoning/, never the log, the tree or a request; off: it is only streamed live), and
  // `commit` lets persist commit that file with the rest of the data dir. Both default to true.
  reasoning: Schema.optional(Schema.Struct({ keep: Schema.optional(Schema.Boolean), commit: Schema.optional(Schema.Boolean) })),
  // Subagents (SPEC "Subagents"): `max` running at once, every level of nesting counted (SUBAGENTS_MAX);
  // `wake`: a report that reaches an idle master starts a turn (E39; off: it waits for the next
  // one, as in M7a); `wakeLimit`: woken turns in a row before waking pauses (WAKE_LIMIT, 0: none);
  // `worktrees`: where every device keeps isolated subagents' git worktrees (WORKTREES, `~` that
  // device's home); `disposable`: names of gitignored files a finished worktree may be removed with,
  // besides src/worktree.ts DISPOSABLE (`*` within a name; any other ignored file keeps it). All
  // optional.
  subagents: Schema.optional(
    Schema.Struct({
      max: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      wake: Schema.optional(Schema.Boolean),
      wakeLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      worktrees: Schema.optional(Schema.String),
      disposable: Schema.optional(Schema.Array(Schema.String.check(Schema.isPattern(/^[^/]+$/)))),
    }),
  ),
  // The artifacts the master publishes (SPEC "Artifacts"): `commit` lets persist commit their
  // folder (streams/<device>/artifacts/) with the rest of the data dir. Defaults to true.
  artifacts: Schema.optional(Schema.Struct({ commit: Schema.optional(Schema.Boolean) })),
  // Sign in with ChatGPT endpoints (src/openai/endpoints.ts): each key left out, or the whole field, decodes to its default
  openai: Endpoints.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
}).check(Schema.makeFilter((s) => {
  const problems = [
    ...duplicateRefs("master.chain", s.master.chain, s.master.effort),
    ...s.compactor.byLevel.flatMap((b, i) => duplicateRefs(`compactor.byLevel[${i}].chain`, b.chain, s.compactor.effort)),
    ...duplicateRefs("media.caption", s.media?.caption ?? []),
  ];
  return problems.length === 0 ? undefined : problems.join("; ");
}));
export type Settings = typeof Settings.Type;

// typed authoring of optchat.config.ts
export const defineConfig = (settings: typeof Settings.Encoded) => settings;
// settings from their written form, for settings built in code (tests, dev scripts); throws
export const parseSettings = Schema.decodeSync(Settings);

// a turn's `--tools` when master.tools names none, and the compactor's too (they share the cached
// prefix). TodoWrite is Claude Code's todo list, which the web UI shows as the turn's plan
export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

const decodeSettings = Schema.decodeUnknownEffect(Settings);
// what `import` of optchat.config.ts gives: its default export is checked against Settings next
const decodeModule = Schema.decodeUnknownSync(Schema.Struct({ default: Schema.Json }));

export const loadSettings = (path: string) =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      catch: (cause) => new ConfigError({ message: `cannot load ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      try: async () => decodeModule(await import(pathToFileURL(realpathSync(path)).href)).default,
    });
    // every engine ref is decoded here, so nothing after this parses one again
    const settings = yield* decodeSettings(module).pipe(
      Effect.mapError((e) => new ConfigError({ message: `${path}: ${e.message}` })),
    );
    for (const [name, d] of Object.entries(settings.devices))
      // http only: the runner listens on the tailnet address itself, and RemoteRunner dials its IPv4
      if (!URL.canParse(d.url) || new URL(d.url).protocol !== "http:")
        return yield* new ConfigError({ message: `${path}: device ${name}'s url ${d.url} is not an http:// URL` });
    if (!(settings.defaultDevice in settings.devices))
      return yield* new ConfigError({ message: `${path}: defaultDevice ${settings.defaultDevice} is not among the devices` });
    return settings;
  });

// the compactor chain for a node at `level`: the last entry whose `from` is at or below it
export const chainFor = (settings: Settings, level: number) =>
  settings.compactor.byLevel.findLast((b) => b.from <= level)?.chain ?? settings.compactor.byLevel[0].chain;

// a cheap vision call describes each attachment for the log
const CAPTION_DEFAULT: Ref = { engine: "claude-code", model: "haiku", ref: "claude-code:haiku" };

// the media settings with their defaults filled in (SPEC "Media")
export const mediaSettings = (settings: Settings) => {
  const m = settings.media ?? {};
  return {
    caption: m.caption ?? [CAPTION_DEFAULT],
    captionWait: m.captionWait ?? 10_000,
    ffmpeg: m.ffmpeg ?? "ffmpeg",
    ffprobe: m.ffprobe ?? "ffprobe",
    maxImageBytes: m.maxImageBytes ?? 30 * 1024 * 1024,
    // GitHub warns at 50 MB and refuses a file over 100 MiB, and persist commits every video
    // (SPEC "Media"). The server's request body limit (server/app.ts) is set from this and
    // maxImageBytes, so a bigger value here is taken as it stands.
    maxVideoBytes: m.maxVideoBytes ?? 50 * 1024 * 1024,
    maxVideoSeconds: m.maxVideoSeconds ?? 180,
    planImages: m.planImages ?? false,
    // seconds each ffmpeg or whisper call may take on top of the clip's length
    toolSeconds: m.toolSeconds ?? 60,
    whisper: m.whisper ?? null,
    // Seconds whisper may take on top of the clip's length. ffmpeg only copies and decodes, so a
    // minute is plenty for it; whisper first loads a model from a cold disk (a few GB for a large
    // one, 10-30 s) and then decodes at about real time on a CPU, which the clip's length covers.
    // 120 s is that load with a wide margin, and a hung process still dies at about two minutes
    // past the clip.
    whisperSeconds: m.whisperSeconds ?? 120,
  };
};
export type MediaSettings = ReturnType<typeof mediaSettings>;

// the subagent settings with their defaults filled in (SPEC "Subagents")
export const subagentSettings = (settings: Settings) => ({
  max: settings.subagents?.max ?? SUBAGENTS_MAX,
  wake: settings.subagents?.wake ?? true,
  wakeLimit: settings.subagents?.wakeLimit ?? WAKE_LIMIT,
  worktrees: settings.subagents?.worktrees ?? WORKTREES,
  disposable: settings.subagents?.disposable ?? [],
});

// the reasoning settings with their defaults filled in (SPEC "Reasoning")
// the artifact settings with their defaults filled in (SPEC "Artifacts")
export const artifactSettings = (settings: Settings) => ({ commit: settings.artifacts?.commit ?? true });
export const reasoningSettings = (settings: Settings) => ({ commit: settings.reasoning?.commit ?? true, keep: settings.reasoning?.keep ?? true });
