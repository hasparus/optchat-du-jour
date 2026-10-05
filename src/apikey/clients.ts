// The api-key engine's clients (SPEC "Engines", api-key): Anthropic's Messages API and OpenAI's
// Responses API, each with its key from Secrets (the Keychain; never the repo or the data dir).
// No key, or a key the API rejects, is a UsageLimit: the chain moves on.
import { Context, Effect, Layer, Option } from "effect";
import { UsageLimit } from "../engines/errors.ts";
import { makeResponses, type Respond } from "../openai/responses.ts";
import { Secrets } from "../secrets.ts";
import { ANTHROPIC_API, makeMessages, type Messages } from "./anthropic.ts";

export const OPENAI_API = "https://api.openai.com/v1";
// the Secrets entries `optchat key anthropic` and `optchat key openai` write
export const KEY_SECRETS = { anthropic: "anthropic-api-key", openai: "openai-api-key" } as const;

export class ApiKeys extends Context.Service<ApiKeys, { readonly anthropic: Messages; readonly openai: Respond }>()("optchat/ApiKeys") {}

// `report`: what the user should hear (an OpenAI model that refuses cache breakpoints)
export const apiKeysLayer = (o: { readonly anthropicUrl?: string; readonly openaiUrl?: string; readonly report?: (message: string) => Effect.Effect<void> } = {}) =>
  Layer.effect(
    ApiKeys,
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const key = (provider: keyof typeof KEY_SECRETS) =>
        secrets.get(KEY_SECRETS[provider]).pipe(
          Effect.mapError((e) => new UsageLimit({ message: `api-key: ${e.message}` })),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new UsageLimit({ message: `api-key: no ${provider} key: run \`optchat key ${provider}\`` })),
              onSome: Effect.succeed,
            }),
          ),
        );
      const anthropic = yield* makeMessages({ base: o.anthropicUrl ?? ANTHROPIC_API, key: key("anthropic") });
      const openai = yield* makeResponses({
        api: o.openaiUrl ?? OPENAI_API,
        bearer: { current: key("openai"), renew: () => Effect.fail(new UsageLimit({ message: "api-key: openai rejected the key" })) },
        label: "api-key: openai",
        report: o.report,
      });
      return { anthropic, openai };
    }),
  );
