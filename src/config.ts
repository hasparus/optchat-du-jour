import { Data, Effect, Schema } from "effect";
// The gist's constants (gist §1) and the reference's timings (ref §2, §7). Sizes are UTF-8
// bytes, cache marks are characters. Everything that may differ per machine is in
// optchat.config.ts instead.
export const NODE = 512;
export const VIEW = 128_000;
export const JOBS = 8;
export const TRIES = 5;
export const RETRY = "10 seconds";
export const CAP = 30_000;
export const MARKS: readonly number[] = [50_000, 80_000, 100_000];

export const CALL_TIMEOUT = "5 minutes";
export const KILL_GRACE = "5 seconds";
export const PRIME_TIMEOUT = "30 seconds";
export const PRIME_IDLE = "1 second";

// ---------------------------------------------------------------------------------------------
// optchat.config.ts (SPEC "Constants and configuration"): engines, compactor chains per level,
// cache TTLs, devices, who may connect.


const Ttl = Schema.Literals(["1h", "5m"]);
const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
// "engine:model", e.g. "claude-code:opus"
const EngineRef = Schema.String.check(Schema.isPattern(/^(claude-code|openai-plan|api-key):.+$/));
const Chain = Schema.NonEmptyArray(EngineRef);

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
  server: Schema.optional(Schema.Struct({ host: Schema.String, port: Schema.Int })),
});
export type Settings = typeof Settings.Type;

// typed authoring of optchat.config.ts
export const defineConfig = (settings: typeof Settings.Encoded) => settings;

export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

// the engines this build can run; a chain naming another is a configuration error, not a failover
export const IMPLEMENTED: readonly string[] = ["claude-code"];

const decodeSettings = Schema.decodeUnknownEffect(Settings);

export const loadSettings = (path: string) =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      catch: (cause) => new ConfigError({ message: `cannot load ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      try: async (): Promise<{ readonly default?: unknown }> => import(path),
    });
    const settings = yield* decodeSettings(module.default).pipe(
      Effect.mapError((e) => new ConfigError({ message: `${path}: ${e.message}` })),
    );
    const engines = [...settings.master.chain, ...settings.compactor.byLevel.flatMap((b) => b.chain)];
    for (const ref of engines)
      if (!IMPLEMENTED.includes(ref.split(":")[0] ?? ""))
        return yield* new ConfigError({ message: `${path}: engine ${ref} is not implemented yet` });
    if (!(settings.defaultDevice in settings.devices))
      return yield* new ConfigError({ message: `${path}: defaultDevice ${settings.defaultDevice} is not among the devices` });
    return settings;
  });

// the compactor chain for a node at `level`: the last entry whose `from` is at or below it
export const chainFor = (settings: Settings, level: number) =>
  settings.compactor.byLevel.filter((b) => b.from <= level).at(-1)?.chain ?? settings.compactor.byLevel[0].chain;
