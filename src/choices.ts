// What the clients chose for the session (SPEC "Turn and priming", follow-ups and the lead
// engine), kept in the data dir as session.json so a restart keeps it: the follow-up behavior and
// the engine the next turn tries first. A file that is missing or doesn't decode counts as no
// choice; a lead the chain no longer has is dropped by the session. It is committed with the rest
// of the data dir.
import { Effect, Option, Schema } from "effect";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { FollowUp } from "./wire.ts";

export const Choices = Schema.Struct({ followUp: Schema.optional(FollowUp), lead: Schema.optional(Schema.String) });
export type Choices = typeof Choices.Type;

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Choices));

export const loadChoices = (path: string): Choices => (existsSync(path) ? Option.getOrElse(decode(readFileSync(path, "utf8")), () => ({})) : {});

// written whole, through a temporary file, so a crash leaves the old one or the new one; a failed
// write is said and costs only the choice's surviving a restart
export const saveChoices = (path: string, report: (message: string) => Effect.Effect<void>) => (c: Choices) =>
  Effect.try({
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    try: () => {
      writeFileSync(`${path}.tmp`, `${JSON.stringify(c)}\n`);
      renameSync(`${path}.tmp`, path);
    },
  }).pipe(Effect.catch((error) => report(`session.json: ${error}; the choice lasts until the server restarts`)));
