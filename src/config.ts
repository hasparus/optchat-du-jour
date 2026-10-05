// The gist's constants (gist §1) and the reference's timings (ref §2, §7). Sizes are UTF-8
// bytes, cache marks are characters. Everything that may differ per machine is in
// optchat.config.ts instead.
import { Data, Effect, Schema } from "effect";

// a summary line's target size, and the most a free node may hold
export const NODE = 512;
// the view's budget
export const VIEW = 128_000;
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
// requests one turn of our own tool loop may make (openai-plan, api-key); the last one may not
// call tools, so the turn ends with an answer (M5)
export const TOOL_ROUNDS = 40;

// optchat.config.ts (SPEC "Constants and configuration"): engines, compactor chains per level,
// cache TTLs, devices, who may connect.

const Ttl = Schema.Literals(["1h", "5m"]);
const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
// "engine:model", e.g. "claude-code:opus"
const EngineRef = Schema.String.check(Schema.isPattern(/^(claude-code|openai-plan|api-key):.+$/));
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
  }),
  compactor: Schema.Struct({
    byLevel: Schema.NonEmptyArray(Schema.Struct({ from: Schema.Int, chain: Chain })),
    effort: Effort,
  }),
  cache: Schema.Struct({ claudeCodeTtl: Ttl, primeTtl: Ttl, apiKeyTtls: Schema.Array(Ttl) }),
  devices: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String, folders: Schema.Array(Schema.String) })),
  defaultDevice: Schema.String,
  allowedLogins: Schema.Array(Schema.String),
  // publicUrl: the server as the tailnet reaches it (`tailscale serve`), for claude on other devices
  server: Schema.optional(Schema.Struct({ host: Schema.String, port: Schema.Int, publicUrl: Schema.optional(Schema.String) })),
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
  // Sign in with ChatGPT endpoints, each overriding src/openai/auth.ts DEFAULT_ENDPOINTS
  openai: Schema.optional(
    Schema.Struct({
      issuer: Schema.optional(Schema.String),
      api: Schema.optional(Schema.String),
      registerClientId: Schema.optional(Schema.String),
      port: Schema.optional(Schema.Int),
      agentName: Schema.optional(Schema.String),
    }),
  ),
});
export type Settings = typeof Settings.Type;

// typed authoring of optchat.config.ts
export const defineConfig = (settings: typeof Settings.Encoded) => settings;

export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

// the engines this build can run, per role; a chain naming another is a configuration error, not a failover
export const IMPLEMENTED = {
  compactor: ["claude-code", "openai-plan", "api-key"],
  master: ["claude-code", "openai-plan", "api-key"],
} as const satisfies Record<string, readonly string[]>;

// "api-key:anthropic/claude-opus-5-5" → the provider and its model id
export const API_KEY_REF = /^api-key:(anthropic|openai)\/(.+)$/;
export const apiKeyRef = (ref: string) => {
  const m = API_KEY_REF.exec(ref);
  return m?.[1] === "anthropic" || m?.[1] === "openai" ? { model: m[2] ?? "", provider: m[1] } : null;
};

const decodeSettings = Schema.decodeUnknownEffect(Settings);
// what `import` of optchat.config.ts gives: its default export is checked against Settings next
const decodeModule = Schema.decodeUnknownSync(Schema.Struct({ default: Schema.Json }));

export const loadSettings = (path: string) =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      catch: (cause) => new ConfigError({ message: `cannot load ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      try: async () => decodeModule(await import(path)).default,
    });
    const settings = yield* decodeSettings(module).pipe(
      Effect.mapError((e) => new ConfigError({ message: `${path}: ${e.message}` })),
    );
    const roles = [
      { built: IMPLEMENTED.master, refs: settings.master.chain, role: "master" },
      { built: IMPLEMENTED.compactor, refs: settings.compactor.byLevel.flatMap((b) => b.chain), role: "compactor" },
    ];
    for (const { built, refs, role } of roles)
      for (const ref of refs)
        if (!built.some((engine) => ref.startsWith(`${engine}:`)))
          return yield* new ConfigError({ message: `${path}: engine ${ref} is not implemented yet as a ${role}` });
    for (const ref of [...settings.master.chain, ...settings.compactor.byLevel.flatMap((b) => b.chain)])
      if (ref.startsWith("api-key:") && !apiKeyRef(ref))
        return yield* new ConfigError({ message: `${path}: ${ref} must be api-key:anthropic/<model> or api-key:openai/<model>` });
    // Anthropic takes at most 4 marks, and 1-hour entries must come before 5-minute ones
    const ttls = settings.cache.apiKeyTtls;
    if (ttls.length > 4 || ttls.some((t, k) => t === "1h" && ttls.slice(0, k).includes("5m")))
      return yield* new ConfigError({ message: `${path}: cache.apiKeyTtls takes at most 4 entries, every "1h" before any "5m"` });
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
