// The gist's constants (gist §1) and the reference's timings (ref §2, §7). Sizes are UTF-8
// bytes, cache marks are characters. Everything that may differ per machine is in
// optchat.config.ts instead.
import { Data, Effect, Result, Schema } from "effect";
import { Endpoints } from "./openai/endpoints.ts";
import { Engine } from "./usage.ts";

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

// optchat.config.ts (SPEC "Constants and configuration"): engines, compactor chains per level,
// cache TTLs, devices, who may connect.

const Ttl = Schema.Literals(["1h", "5m"]);
const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
// "engine:model", e.g. "claude-code:opus"; parseRef says whether this build runs it as a role
const EngineRef = Schema.String.check(Schema.isPattern(new RegExp(`^(${Engine.literals.join("|")}):.+$`)));
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
  // publicUrl: the server as the tailnet reaches it (`tailscale serve`), for claude on other devices
  server: Schema.optional(Schema.Struct({ host: Schema.String, port: Schema.Int, publicUrl: Schema.optional(Schema.String) })),
  // Sign in with ChatGPT endpoints (src/openai/endpoints.ts): each key left out, or the whole field, decodes to its default
  openai: Endpoints.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});
export type Settings = typeof Settings.Type;

// typed authoring of optchat.config.ts
export const defineConfig = (settings: typeof Settings.Encoded) => settings;

export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

// the engines this build can run, per role; a chain naming another is a configuration error, not a failover
export const IMPLEMENTED = { compactor: ["claude-code", "openai-plan"], master: ["claude-code"] } as const satisfies Record<string, readonly (typeof Engine.Type)[]>;
export type Role = keyof typeof IMPLEMENTED;
export type Ref<R extends Role> = { readonly engine: (typeof IMPLEMENTED)[R][number]; readonly model: string };

// "engine:model" for a role: an engine this build runs as that role, and a model
export const parseRef = <R extends Role>(role: R, ref: string): Result.Result<Ref<R>, string> => {
  const [name = "", model = ""] = ref.split(/:(.*)/s);
  const engine = IMPLEMENTED[role].find((e) => e === name);
  if (model === "") return Result.fail(`engine ${ref}: expected engine:model`);
  if (engine === undefined) return Result.fail(`engine ${ref} is not implemented yet as a ${role}`);
  return Result.succeed({ engine, model });
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
    const roles: readonly { readonly refs: readonly string[]; readonly role: Role }[] = [
      { refs: settings.master.chain, role: "master" },
      { refs: settings.compactor.byLevel.flatMap((b) => b.chain), role: "compactor" },
    ];
    for (const { refs, role } of roles)
      for (const ref of refs) {
        const parsed = parseRef(role, ref);
        if (Result.isFailure(parsed)) return yield* new ConfigError({ message: `${path}: ${parsed.failure}` });
      }
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
