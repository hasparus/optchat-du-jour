// Where tokens live (SPEC "Tailscale, auth and operations": secrets in the macOS Keychain, never in
// the repo or the data dir). The Keychain through `security` on a Mac; elsewhere a 0600 file under
// ~/.config/optchat; in tests, a map.
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export class SecretsError extends Data.TaggedError("SecretsError")<{ readonly message: string }> {}

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<string>, SecretsError>;
    readonly set: (name: string, value: string) => Effect.Effect<void, SecretsError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretsError>;
  }
>()("optchat/Secrets") {}

export const memorySecrets = (initial: Readonly<Record<string, string>> = {}) => {
  const map = new Map(Object.entries(initial));
  return Layer.succeed(Secrets)({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(map.get(name))),
    remove: (name) =>
      Effect.sync(() => {
        map.delete(name);
      }),
    set: (name, value) =>
      Effect.sync(() => {
        map.set(name, value);
      }),
  });
};

const Store = Schema.Record(Schema.String, Schema.String);
const decodeStore = Schema.decodeUnknownSync(Schema.fromJsonString(Store));
const fail = (what: string) => (cause: unknown) =>
  new SecretsError({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` });

// one JSON file, owner-only, written whole through a rename so a crash never leaves half of it
export const fileSecrets = (path: string) => {
  const read = Effect.try({ catch: fail(path), try: () => (existsSync(path) ? decodeStore(readFileSync(path, "utf8")) : {}) });
  const write = (store: Readonly<Record<string, string>>) =>
    Effect.try({
      catch: fail(path),
      try: () => {
        mkdirSync(dirname(path), { mode: 0o700, recursive: true });
        writeFileSync(`${path}.tmp`, JSON.stringify(store), { mode: 0o600 });
        chmodSync(`${path}.tmp`, 0o600);
        renameSync(`${path}.tmp`, path);
      },
    });
  return Layer.succeed(Secrets)({
    get: (name) => read.pipe(Effect.map((store) => Option.fromUndefinedOr(store[name]))),
    remove: (name) => read.pipe(Effect.flatMap((store) => write(Object.fromEntries(Object.entries(store).filter(([k]) => k !== name))))),
    set: (name, value) => read.pipe(Effect.flatMap((store) => write({ ...store, [name]: value }))),
  });
};

// `security` runs one command per line from stdin with -i, so a value never shows in argv (ps).
// Values are stored base64-encoded: nothing in them then needs quoting on that line.
const SERVICE = "optchat";
const security = (args: readonly string[], stdin?: string) =>
  Effect.tryPromise({
    catch: fail("security"),
    try: async () => {
      const p = Bun.spawn(["security", ...args], { stderr: "pipe", stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, err: err.trim(), out: out.trim() };
    },
  });
const ITEM_NOT_FOUND = 44; // security's exit code for a missing item

export const keychainSecrets = Layer.succeed(Secrets)({
  get: (name) =>
    security(["find-generic-password", "-s", SERVICE, "-a", name, "-w"]).pipe(
      Effect.flatMap(({ code, err, out }) => {
        if (code === ITEM_NOT_FOUND) return Effect.succeed(Option.none());
        if (code !== 0) return Effect.fail(new SecretsError({ message: `keychain: ${err}` }));
        return Effect.succeed(Option.some(Buffer.from(out, "base64").toString("utf8")));
      }),
    ),
  remove: (name) =>
    security(["delete-generic-password", "-s", SERVICE, "-a", name]).pipe(
      Effect.flatMap(({ code, err }) =>
        code === 0 || code === ITEM_NOT_FOUND ? Effect.void : Effect.fail(new SecretsError({ message: `keychain: ${err}` })),
      ),
    ),
  set: (name, value) =>
    security(["-i"], `add-generic-password -U -s ${SERVICE} -a ${name} -w ${Buffer.from(value).toString("base64")}\n`).pipe(
      Effect.flatMap(({ code, err }) => (code === 0 ? Effect.void : Effect.fail(new SecretsError({ message: `keychain: ${err}` })))),
    ),
});

// this machine's store: the Keychain on macOS; $OPTCHAT_SECRETS or ~/.config/optchat/secrets.json elsewhere
export const SecretsLive =
  process.platform === "darwin"
    ? keychainSecrets
    : fileSecrets(Bun.env.OPTCHAT_SECRETS ?? `${Bun.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/optchat/secrets.json`);
