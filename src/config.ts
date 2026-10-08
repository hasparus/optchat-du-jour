// The gist's constants (gist §1) and the reference's timings (ref §2, §7). Sizes are UTF-8
// bytes, cache marks are characters. Everything that may differ per machine is in
// optchat.config.ts instead.
import { Data, Effect, Result, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Endpoints } from "./openai/endpoints.ts";
import { Engine } from "./usage.ts";
import { FollowUp } from "./wire.ts";

// a summary line's target size, and the most a free node may hold
export const NODE = 512;
// The view's sawtooth (gist 2026-10-08 §3.2): each message appends its line, and once the view
// passes VIEW_HIGH one batch of merges takes it down to VIEW_LOW
export const VIEW_HIGH = 128_000;
export const VIEW_LOW = 64_000;
// compactor calls at once
export const JOBS = 8;
// tries per node to get a summary under NODE
export const TRIES = 5;
// the wait before a failed node is tried again: fixed, forever
export const RETRY = "10 seconds";
// the most characters of one tool result that get logged
export const CAP = 30_000;
// cache breakpoints inside the view
export const MARKS: readonly number[] = [50_000, 80_000, 100_000];

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

// optchat.config.ts (SPEC "Constants and configuration"): engines, compactor chains per level,
// cache TTLs, devices, who may connect.

const Ttl = Schema.Literals(["1h", "5m"]);
// How claude reaches /mcp (E8). "ws" is a type Claude Code's config schema takes but does not
// document (probed on 2.1.289: it connects, with subprotocol "mcp" and no Origin); "http" is.
export const McpTransport = Schema.Literals(["ws", "http"]);
export type McpTransport = typeof McpTransport.Type;
const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);

// An engine of a chain (E4, E5), written "engine:model" ("claude-code:opus"), decoded once with the
// settings: the engine, the model it is given, and `ref`, the text as written, which names the
// engine in notices and usage.jsonl. An api-key ref names its provider too
// ("api-key:anthropic/claude-opus-5-5"), and `model` is that provider's model id.
const Model = { model: Schema.String, ref: Schema.String };
const RefValue = Schema.Union([
  Schema.Struct({ engine: Schema.Literal("claude-code"), ...Model }),
  Schema.Struct({ engine: Schema.Literal("openai-plan"), ...Model }),
  Schema.Struct({ engine: Schema.Literal("api-key"), provider: Schema.Literals(["anthropic", "openai"]), ...Model }),
]);
export type Ref = typeof RefValue.Type;
// a ref whose engine runs on a provider (src/providers/): everything but claude-code, which runs its own loop
export type ProviderRef = Exclude<Ref, { readonly engine: "claude-code" }>;
export type ApiKeyRef = Extract<Ref, { readonly engine: "api-key" }>;

export const parseRef = (ref: string): Result.Result<Ref, string> => {
  const [engine = "", model = ""] = ref.split(/:(.*)/s);
  if (model === "") return Result.fail(`engine ${ref}: expected engine:model`);
  if (engine === "claude-code" || engine === "openai-plan") return Result.succeed({ engine, model, ref });
  if (engine !== "api-key") return Result.fail(`engine ${ref}: no such engine (${Engine.literals.join(", ")})`);
  const [, provider, id] = /^(anthropic|openai)\/(.+)$/.exec(model) ?? [];
  if ((provider !== "anthropic" && provider !== "openai") || id === undefined) return Result.fail(`${ref} must be api-key:anthropic/<model> or api-key:openai/<model>`);
  return Result.succeed({ engine, model: id, provider, ref });
};

const EngineRef = Schema.String.pipe(
  Schema.decodeTo(
    RefValue,
    SchemaTransformation.transformEffect({
      decode: (text, options) =>
        Result.match(parseRef(text), {
          onFailure: (message) => Effect.fail(new SchemaIssue.InvalidValue({ message }, text, options)),
          onSuccess: Effect.succeed,
        }),
      encode: (r) => Effect.succeed(r.ref),
    }),
  ),
);
const Chain = Schema.NonEmptyArray(EngineRef);
// dollars per million tokens (SPEC "Usage and cost tracking"); cache writes per TTL, Anthropic only
const Price = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite5m: Schema.optional(Schema.Number),
  cacheWrite1h: Schema.optional(Schema.Number),
});
export type Price = typeof Price.Type;

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
  }),
  compactor: Schema.Struct({
    byLevel: Schema.NonEmptyArray(Schema.Struct({ from: Schema.Int, chain: Chain })),
    effort: Effort,
  }),
  // claude-code's own TTLs (E6). An API key's requests have no setting: gist §8's layout, 5-minute
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
  // is logged without them (ms), upload limits, the ffmpeg tools for video and how long each call
  // may take (`toolSeconds`, on top of the clip's length), a local whisper
  // command (the WAV's path is appended; none: audio is not transcribed) with its own limit
  // (`whisperSeconds`, on top of the clip's length), and whether the ChatGPT
  // plan's route is sent images (not probed yet, so off unless set)
  media: Schema.optional(
    Schema.Struct({
      caption: Schema.optional(Chain),
      captionWait: Schema.optional(Schema.Number),
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
  // Sign in with ChatGPT endpoints (src/openai/endpoints.ts): each key left out, or the whole field, decodes to its default
  openai: Endpoints.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});
export type Settings = typeof Settings.Type;

// typed authoring of optchat.config.ts
export const defineConfig = (settings: typeof Settings.Encoded) => settings;
// settings from their written form, for settings built in code (tests, dev scripts); throws
export const parseSettings = Schema.decodeSync(Settings);

export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

const decodeSettings = Schema.decodeUnknownEffect(Settings);
// what `import` of optchat.config.ts gives: its default export is checked against Settings next
const decodeModule = Schema.decodeUnknownSync(Schema.Struct({ default: Schema.Json }));

export const loadSettings = (path: string) =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      catch: (cause) => new ConfigError({ message: `cannot load ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      try: async () => decodeModule(await import(path)).default,
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
