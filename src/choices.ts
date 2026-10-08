// What the clients chose for the session (SPEC "Turn and priming", follow-ups), kept in the data
// dir as session.json so a restart keeps it: the follow-up behavior. A file that is missing counts
// as no choice; one that can't be read or doesn't decode is reported and counts as no choice too.
// A key it no longer has (an older server's `lead`) is ignored. It is committed with the rest of
// the data dir.
import { Effect, Schema } from "effect";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { FollowUp } from "./wire.ts";

export const Choices = Schema.Struct({ followUp: Schema.optional(FollowUp) });
export type Choices = typeof Choices.Type;

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Choices));
const why = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// the saved choices
export const loadChoices = (path: string, report: (message: string) => Effect.Effect<void>): Effect.Effect<Choices> =>
  Effect.gen(function* () {
    if (!existsSync(path)) return {};
    return yield* Effect.try({ catch: why, try: () => readFileSync(path, "utf8") }).pipe(Effect.flatMap((text) => decode(text).pipe(Effect.mapError(why))));
  }).pipe(Effect.catch((error) => report(`session.json can't be used (${error}): the choices start afresh`).pipe(Effect.as({}))));

// What the session starts with: the saved choice, else the config's (`master.followUp`). A file
// that names none (an older server's, with only a `lead`) never unsets the config's.
export const startingChoices = (config: Choices, saved: Choices): Choices => ({ followUp: saved.followUp ?? config.followUp });

// Written whole, through a temporary file that is fsynced before the rename (0600, like the
// store's files), so a crash leaves the old one or the new one; a failed write is said and costs
// only the choice's surviving a restart.
export const saveChoices = (path: string, report: (message: string) => Effect.Effect<void>) => (c: Choices) =>
  Effect.try({
    catch: why,
    try: () => {
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(c)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    },
  }).pipe(Effect.catch((error) => report(`session.json: ${error}; the choice lasts until the server restarts`)));
