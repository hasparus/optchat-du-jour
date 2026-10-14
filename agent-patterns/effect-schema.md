# Schema boundaries (Effect 4.0.4)

Start with [LLMS.md](../repos/effect/LLMS.md) and
[Schema basics](../repos/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts).
Contracts and implementations: [Schema.ts](../repos/effect/packages/effect/src/Schema.ts)
(`decodeUnknownEffect`, `encodeEffect`, `fromJsonString`, `NumberFromString`). Read relevant
sections of [SCHEMA.md](../repos/effect/packages/effect/SCHEMA.md), especially optional fields,
transformations and canonical codecs. Tests: [schema/Schema.test.ts](../repos/effect/packages/effect/test/schema/Schema.test.ts)
(“keeps synchronous decode and encode effects eager”, decoder options, excess properties).

- Describe untrusted HTTP, process and disk input with `Struct`, `Array`, `Union`, `Literals`
  and optional fields. Reuse decoders at the boundary. `typeof Model.Type` is the decoded type;
  `typeof Model.Encoded` may differ when transformations are involved.
- Use `Schema.decodeUnknownEffect` for unknown data in Effect: failures are `SchemaError`,
  with decoding services retained. Use `decodeEffect` when input already has the Encoded type.
  Use `encodeEffect` for the reverse direction. Sync decoders can throw and are not a substitute
  for typed error handling inside Effect. Option decoders are appropriate only when discarding
  validation details is intentional.
- `Schema.fromJsonString(Model)` parses JSON before validating Model and encodes Model before
  stringifying. `NumberFromString` demonstrates a string-to-number boundary; numeric constraints
  still need to express the domain. Do not assert parsed JSON as a domain type.
- Decide excess-property policy explicitly. The decoder-options test demonstrates that
  `onExcessProperty: "error"` rejects an additional key, while `"ignore"` drops it. Do not enable
  strict rejection on extensible provider payloads without compatibility review.
- For classes, dates, collections or other non-JSON values, inspect canonical codecs before
  assuming `JSON.stringify` round-trips them. Add malformed-input and encode/decode tests.

Adapted JSON boundary:

```ts
import { Schema } from "effect";

const Payload = Schema.Struct({ id: Schema.Int, body: Schema.String });
const JsonPayload = Schema.fromJsonString(Payload);
const decodePayload = Schema.decodeUnknownEffect(JsonPayload);
const encodePayload = Schema.encodeEffect(JsonPayload);
```

Optchat shares [wire.ts](../src/wire.ts) with clients. Preserve compatibility of persisted
records and streamed provider events; [auth.ts](../src/openai/auth.ts) and
[assets.ts](../src/media/assets.ts) show existing boundaries. Never discard a valid usage/spend
record because an unrelated field or later response is invalid. Validation should not leak
credentials into logs or make known spend disappear. No blanket schema or collection rewrites.
