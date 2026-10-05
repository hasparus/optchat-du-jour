// Sign in with ChatGPT's endpoints (src/openai/auth.ts), kept apart from it so that config.ts
// pulls in only Schema, not crypto, HTTP and the Keychain.
import { Effect, Schema } from "effect";

// Every endpoint is configurable (optchat.config.ts `openai`), since none of this is ours to fix;
// a key left out decodes to its default.
const or = <S extends Schema.Top>(value: S["Encoded"]) => (schema: S) => schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
export const Endpoints = Schema.Struct({
  issuer: Schema.String.pipe(or("https://auth.openai.com")),
  api: Schema.String.pipe(or("https://api.openai.com/v1")), // the Responses API base, also the OAuth `resource`
  registerClientId: Schema.String.pipe(or("dynamic_agent_client")),
  // the callback's; the docs allow any port, only http://127.0.0.1:{port}/auth/callback. 1455 is
  // Codex CLI's (codex-rs/login, DEFAULT_PORT); ours only needs to be free.
  port: Schema.Int.pipe(or(1455)),
  agentName: Schema.String.pipe(or("optchat-du-jour")), // agent_name_hint: what the user sees in ChatGPT Settings → Usage
});
export type Endpoints = typeof Endpoints.Type;
export const DEFAULT_ENDPOINTS: Endpoints = Schema.decodeUnknownSync(Endpoints)({});
