// What the clients chose for the session (SPEC "Engines", E4; "Turn and priming", follow-ups),
// kept in the data dir as session.json so a restart keeps it: the follow-up behavior and the
// engine turns run on. A file that is missing counts as no choice; one that can't be read or
// doesn't decode, or a lead the chain no longer has, is reported and counts as no choice too. It
// is committed with the rest of the data dir.
import { Effect, Schema } from "effect";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { FollowUp } from "./wire.ts";

export const Choices = Schema.Struct({ followUp: Schema.optional(FollowUp), lead: Schema.optional(Schema.String) });
export type Choices = typeof Choices.Type;

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Choices));
const why = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// the saved choices; `chain`: the master's refs, which a saved lead must be among
export const loadChoices = (path: string, chain: readonly string[], report: (message: string) => Effect.Effect<void>): Effect.Effect<Choices> =>
  Effect.gen(function* () {
    if (!existsSync(path)) return {};
    const said = yield* Effect.try({ catch: why, try: () => readFileSync(path, "utf8") }).pipe(Effect.flatMap((text) => decode(text).pipe(Effect.mapError(why))));
    if (said.lead === undefined || chain.includes(said.lead)) return said;
    yield* report(`session.json: ${said.lead} is no longer in the master's chain; turns run on ${chain[0] ?? "its first engine"}`);
    return { followUp: said.followUp };
  }).pipe(Effect.catch((error) => report(`session.json can't be used (${error}): the choices start afresh`).pipe(Effect.as({}))));

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
