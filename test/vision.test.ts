// Attachments in a turn (SPEC "Media"): the sending turn gets real pictures (Anthropic image
// blocks, Responses input_image data URLs), the log only text (the typed words and one marker per
// attachment, with its caption waited for briefly), a failover to an engine that is not sent
// images gets the markers and a note, and the compactor's input keeps a marker's sha.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, PubSub, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer, KEY_SECRETS } from "../src/apikey/clients.ts";
import { openChat } from "../src/chat.ts";
import type { Job } from "../src/compactor.ts";
import { type ApiKeyRef, parseSettings } from "../src/config.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import type { Picture } from "../src/media/part.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { apiKeyProvider } from "../src/providers/api-key.ts";
import { memorySecrets } from "../src/secrets.ts";
import { makeSession, type SessionEvent, type SessionMedia } from "../src/session.ts";
import { step } from "../src/summarize/step.ts";
import { BLIND, type Mid, type TurnEngine, type TurnEvents, type TurnInput } from "../src/turn/engine.ts";
import { toolLoop } from "../src/turn/loop.ts";
import { type Asset, type ImageAsset, markerOf, NOT_DESCRIBED, shortSha } from "../src/wire.ts";
import { fakeAnthropic } from "./fake-anthropic.ts";
import { fakeOpenAi } from "./fake-openai.ts";

const dirs: string[] = [];
const anthropic = fakeAnthropic("sk-ant");
const openai = fakeOpenAi();
afterAll(async () => {
  await anthropic.server.stop(true);
  await openai.server.stop(true);
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const PIC: Picture = { data: Buffer.from("not really a jpeg").toString("base64"), mime: "image/jpeg", type: "image" };
const image = (n: number): ImageAsset => ({ bytes: 200_000, height: 1176, kind: "image", mime: "image/jpeg", sha: String(n).repeat(64).slice(0, 64), width: 1568 });

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

// ---------------------------------------------------------------------------------------------
// the api-key engine's requests

const settings = parseSettings({
  allowedLogins: [],
  apiKey: {
    anthropicUrl: anthropic.base,
    monthlyBudget: 5,
    openaiUrl: `${openai.base}/v1`,
    prices: { "anthropic/claude-opus-5-5": { cacheRead: 0, input: 1, output: 1 }, "openai/gpt-6": { cacheRead: 0, input: 1, output: 1 } },
  },
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: [], url: "http://127.0.0.1:9" } },
  master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
  openai: DEFAULT_ENDPOINTS,
});
const clients = Effect.runSync(
  Effect.gen(function* () {
    return yield* ApiKeys;
  }).pipe(
    Effect.provide(
      apiKeysLayer({ anthropicUrl: anthropic.base, openaiUrl: `${openai.base}/v1` }).pipe(
        Layer.provide([memorySecrets({ [KEY_SECRETS.anthropic]: "sk-ant", [KEY_SECRETS.openai]: "sk-oai" }), FetchHttpClient.layer]),
      ),
    ),
  ),
);
const quiet: TurnEvents = {
  info: () => Effect.void,
  log: () => Effect.void,
  text: () => Effect.void,
  thinking: () => Effect.void,
  took: () => Effect.void,
  usage: () => Effect.void,
};
const VIEW = "<chat>\n0+1|user: hello\n</chat>";
const withPicture: TurnInput = {
  device: "mini",
  earlier: [],
  media: [`image ${shortSha(image(1).sha)}:`, PIC], // as media.parts sends one: a label, then the picture
  mid: { next: Effect.never, ready: Effect.succeed([]) },
  texts: [`what is this?\n${markerOf(image(1), "a red square")}`],
  view: VIEW,
};
const loopOn = (ref: ApiKeyRef) =>
  toolLoop({
    instructions: "MASTER",
    provider: apiKeyProvider({ budget: makeBudget({ monthly: 5, report: () => Effect.void, usagePath: `${tmpdir()}/oc-vision-usage-${crypto.randomUUID()}.jsonl` }), clients, ref, settings }),
    ref: ref.ref,
    toolsFor: () => ({ defs: [], run: () => Effect.succeed("") }),
    vision: true,
  });

const AnthropicBody = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })),
});
const ResponsesBody = Schema.Struct({
  include: Schema.Array(Schema.String),
  reasoning: Schema.Struct({ context: Schema.String }),
  input: Schema.Array(Schema.Struct({ role: Schema.optional(Schema.String), content: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Json))) })),
});

test("api-key turns send the picture: an Anthropic image block after the cached view, a Responses input_image data URL", async () => {
  anthropic.state.script = [{ text: "a red square" }];
  await Effect.runPromise(loopOn({ engine: "api-key", model: "claude-opus-5-5", provider: "anthropic", ref: "api-key:anthropic/claude-opus-5-5" }).run(withPicture, quiet, null));
  const sent = Schema.decodeUnknownSync(Schema.fromJsonString(AnthropicBody))(anthropic.state.seen.at(-1));
  const [first] = sent.messages;
  expect(first?.content.map((b) => b.type)).toEqual(["text", "text", "image", "text"]);
  expect(first?.content[0]).toEqual({ text: VIEW, type: "text" }); // one piece, under the first cut: the request end caches it
  expect(first?.content[1]?.text).toBe("image 111111111111:");
  expect(first?.content[2]).toEqual({ source: { data: PIC.data, media_type: "image/jpeg", type: "base64" }, type: "image" });
  expect(first?.content[3]?.text).toContain("[image 111111111111 1568x1176 195KB: a red square]");

  openai.state.access = "sk-oai";
  openai.state.script = [{ text: "a red square" }];
  await Effect.runPromise(loopOn({ engine: "api-key", model: "gpt-6", provider: "openai", ref: "api-key:openai/gpt-6" }).run(withPicture, quiet, null));
  const asked = Schema.decodeUnknownSync(Schema.fromJsonString(ResponsesBody))(openai.state.seen.at(-1)?.body);
  const parts = asked.input[0]?.content ?? [];
  expect(parts.map((p) => p.type)).toEqual(["input_text", "input_text", "input_image", "input_text"]);
  expect(parts[1]?.text).toBe("image 111111111111:");
  expect(parts[2]).toEqual({ detail: "auto", image_url: `data:image/jpeg;base64,${PIC.data}`, type: "input_image" });
  // an API key's Responses requests are cached as the plan's are (E26); a one-piece view has no cut to mark
  expect([asked.include, asked.reasoning.context]).toEqual([["reasoning.encrypted_content"], "all_turns"]);
  expect(openai.state.seen.at(-1)?.body).not.toContain("prompt_cache_breakpoint");
});

// ---------------------------------------------------------------------------------------------
// the session

// a media service whose captions come when `describe` says, and whose every attachment is PIC;
// `asked` counts how often each attachment's caption was asked for
const fakeMedia = () => {
  const ready = new Map<string, string>();
  const waiting = new Map<string, (caption: string) => void>();
  const asked = new Map<string, number>();
  const media: SessionMedia = {
    caption: (a) =>
      Effect.callback<string>((resume) => {
        asked.set(a.sha, (asked.get(a.sha) ?? 0) + 1);
        const known = ready.get(a.sha);
        if (known === undefined)
          waiting.set(a.sha, (c) => {
            resume(Effect.succeed(c));
          });
        else resume(Effect.succeed(known));
      }),
    parts: () => [PIC],
  };
  const describe = (a: Asset, caption: string) => {
    ready.set(a.sha, caption);
    waiting.get(a.sha)?.(caption);
  };
  return { asked, describe, media, waiting };
};

const rig = (engines: readonly TurnEngine[], media: SessionMedia) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/oc-vision-`);
    dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const session = yield* makeSession({ chat, commit: Effect.succeed(null), defaultDevice: "mini", devices: ["mini"], engines, idle: "1 hour", logUsage: () => Effect.void, media });
    const events: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => events.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    const ended = () => events.filter((e) => e.type === "run-finished").length;
    return { chat, ended, events, log: () => chat.mem.root.map((m) => [m.kind, m.text]), session };
  });

test("a message logs its marker with the caption once it comes; resumed on after a stop, an engine not sent images gets the markers and a note, also mid-run", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seen: { ref: string; media: number; texts: readonly string[]; mid: Mid[] }[] = [];
      const spent: TurnEngine = {
        ref: "seeing:x",
        run: (input) =>
          Effect.gen(function* () {
            seen.push({ media: input.media.length, mid: [], ref: "seeing:x", texts: input.texts });
            return yield* new UsageLimit({ message: "spent" });
          }),
        vision: true,
        warm: () => Effect.void,
      };
      const blind: TurnEngine = {
        ref: "blind:x",
        run: (input, out) =>
          Effect.gen(function* () {
            const mid: Mid[] = [];
            const mine = { media: input.media.length, mid, ref: "blind:x", texts: input.texts };
            seen.push(mine);
            const m = yield* input.mid.next;
            mine.mid.push(m);
            yield* out.took(m);
            yield* out.log("talk", "I can only read the markers");
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const f = fakeMedia();
      const r = yield* rig([spent, blind], f.media);
      const photo = image(1), later = image(2);
      yield* r.session.input("what is this?", { clientId: "c1", media: [photo] });
      // the turn waits for the caption before it logs the message
      yield* until("the caption asked for", () => f.waiting.has(photo.sha));
      expect(r.log()).toEqual([]);
      f.describe(photo, "a red [square]");
      // the seeing engine's limit stops the turn (E4); the user resumes it on the blind one
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* r.session.resume("blind:x");
      yield* until("the blind engine's call", () => seen.length === 2);
      // a picture sent mid-run for the blind engine, its caption already known
      f.describe(later, "a blue circle");
      yield* r.session.input("", { clientId: "c2", engine: "blind:x", media: [later] });
      yield* until("the run's end", () => r.ended() === 2); // the stop's, then the resumed one's

      const first = `what is this?\n[image ${shortSha(photo.sha)} 1568x1176 195KB: a red (square)]`;
      const second = `[image ${shortSha(later.sha)} 1568x1176 195KB: a blue circle]`;
      expect(r.log()).toEqual([
        ["user", first],
        ["user", second],
        ["talk", "I can only read the markers"],
      ]);
      expect(seen.map(({ media, ref, texts }) => ({ media, ref, texts }))).toEqual([
        { media: 1, ref: "seeing:x", texts: [first] },
        { media: 0, ref: "blind:x", texts: [first, BLIND] },
      ]);
      expect(seen[1]?.mid).toEqual([{ media: [], seq: 2, text: `${second}\n${BLIND}` }]);
    }).pipe(Effect.scoped),
  );
});

test("a picture sent mid-run reaches an engine that sees with the message that carries it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const mids: Mid[] = [];
      const seeing: TurnEngine = {
        ref: "seeing:x",
        run: (input, out) =>
          Effect.gen(function* () {
            const m = yield* input.mid.next;
            mids.push(m);
            yield* out.took(m);
          }),
        vision: true,
        warm: () => Effect.void,
      };
      const f = fakeMedia();
      const later = image(3);
      f.describe(later, "a green triangle");
      const r = yield* rig([seeing], f.media);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the call", () => r.session.state().engine === "seeing:x");
      yield* r.session.input("and this", { clientId: "c2", media: [later] });
      yield* until("the run's end", () => r.ended() === 1);
      const text = `and this\n[image ${shortSha(later.sha)} 1568x1176 195KB: a green triangle]`;
      expect(mids).toEqual([{ media: [PIC], seq: 2, text }]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["user", text],
      ]);
    }).pipe(Effect.scoped),
  );
});

// SPEC "Media": after a failover the next link is sent the pictures of the mid-run messages the
// link before took, which it sees in `earlier` only by their marker lines; a blind one gets the note
test("after a stop that followed a mid-run picture message, the engine it is resumed on gets that picture, or the note if it is not sent images", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seen: { ref: string; media: TurnInput["media"]; texts: readonly string[]; earlier: TurnInput["earlier"] }[] = [];
      const note = (ref: string, input: TurnInput) => seen.push({ earlier: input.earlier, media: input.media, ref, texts: input.texts });
      const taker: TurnEngine = {
        ref: "taker:x",
        run: (input, out) =>
          Effect.gen(function* () {
            note("taker:x", input);
            const m = yield* input.mid.next;
            yield* out.took(m);
            return yield* new UsageLimit({ message: "spent" });
          }),
        vision: true,
        warm: () => Effect.void,
      };
      const blind: TurnEngine = {
        ref: "blind:x",
        run: (input) => Effect.sync(() => note("blind:x", input)).pipe(Effect.andThen(Effect.fail(new UsageLimit({ message: "spent too" })))),
        vision: false,
        warm: () => Effect.void,
      };
      const seeing: TurnEngine = {
        ref: "seeing:x",
        run: (input, out) => Effect.sync(() => note("seeing:x", input)).pipe(Effect.andThen(out.log("talk", "a yellow star"))),
        vision: true,
        warm: () => Effect.void,
      };
      const f = fakeMedia();
      const star = image(4);
      f.describe(star, "a yellow star");
      const r = yield* rig([taker, blind, seeing], f.media);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the first call", () => seen.length === 1);
      yield* r.session.input("what is it?", { clientId: "c2", media: [star] });
      // each limit stops the turn (E4); the user resumes it on the blind engine, then the seeing one
      yield* until("the first stop", () => r.session.state().phase === "needs-model");
      yield* r.session.resume("blind:x");
      yield* until("the second stop", () => seen.length === 2 && r.session.state().phase === "needs-model");
      yield* r.session.resume("seeing:x");
      yield* until("the run's end", () => r.ended() === 3);
      const asked = `what is it?\n[image ${shortSha(star.sha)} 1568x1176 195KB: a yellow star]`;
      const earlier = [{ kind: "user", text: asked }] as const;
      expect(seen).toEqual([
        { earlier: [], media: [], ref: "taker:x", texts: ["go"] },
        { earlier, media: [], ref: "blind:x", texts: ["go", BLIND] },
        { earlier, media: [PIC], ref: "seeing:x", texts: ["go"] },
      ]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["user", asked],
        ["talk", "a yellow star"],
      ]);
    }).pipe(Effect.scoped),
  );
});

test("a caption that never comes is logged as not described; more than four attachments are cut to four, and said", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const got: TurnInput[] = [];
      const seeing: TurnEngine = { ref: "seeing:x", run: (input) => Effect.sync(() => void got.push(input)), vision: true, warm: () => Effect.void };
      // the service's own wait ran out
      const media: SessionMedia = { caption: () => Effect.succeed(NOT_DESCRIBED), parts: () => [PIC] };
      const r = yield* rig([seeing], media);
      yield* r.session.input("five", { clientId: "c1", media: [1, 2, 3, 4, 5].map(image) });
      yield* until("the run's end", () => r.ended() === 1);
      const [[, text = ""] = []] = r.log();
      expect(text.split("\n")).toEqual(["five", ...[1, 2, 3, 4].map((n) => `[image ${shortSha(image(n).sha)} 1568x1176 195KB: (not described)]`)]);
      expect(got[0]?.media).toHaveLength(4);
      expect(r.events.flatMap((e) => (e.type === "info" ? [e.message] : []))).toEqual(["at most 4 attachments per message: 1 left out"]);
    }).pipe(Effect.scoped),
  );
});

test("the compactor's input for a message of markers only keeps every sha", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const dir = mkdtempSync(`${tmpdir()}/oc-vision-`);
      dirs.push(dir);
      const jobs: Job[] = [];
      const chat = yield* openChat(dir, { summarize: (job) => Effect.sync(() => (jobs.push(job), `user: four pictures`)) });
      // four markers with long captions: too big for a free node, so the compactor sees it
      const shas = [1, 2, 3, 4].map((n) => image(n));
      const text = shas.map((a) => markerOf(a, "a long description of a photo ".repeat(4))).join("\n");
      expect(Buffer.byteLength(`user: ${text}`)).toBeGreaterThan(512);
      yield* chat.log("user", text);
      yield* until("the summary", () => jobs.length > 0);
      const input = step(jobs[0] ?? { ctx: [], i: 0, l: 0, msg: { date: "", i: 0, kind: "user", size: 0, text: "" } });
      for (const a of shas) expect(input).toContain(shortSha(a.sha));
    }).pipe(Effect.scoped),
  );
});

test("a message that arrives while the turn waits for a caption waits for its own: both markers carry their captions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seeing: TurnEngine = { ref: "seeing:x", run: () => Effect.void, vision: true, warm: () => Effect.void };
      const f = fakeMedia();
      const r = yield* rig([seeing], f.media);
      const a = image(1), b = image(2);
      yield* r.session.input("first", { clientId: "c1", media: [a] });
      yield* until("a's caption asked for", () => f.waiting.has(a.sha));
      // b comes while the turn waits for a's caption: it is not in that turn's batch
      yield* r.session.input("second", { clientId: "c2", media: [b] });
      f.describe(a, "caption A");
      yield* Effect.sleep("20 millis");
      f.describe(b, "caption B"); // well within captionWait
      yield* until("both runs' ends", () => r.ended() === 2);
      expect(r.log()).toEqual([
        ["user", `first\n[image ${shortSha(a.sha)} 1568x1176 195KB: caption A]`],
        ["user", `second\n[image ${shortSha(b.sha)} 1568x1176 195KB: caption B]`],
      ]);
      // each caption was asked for once: the log and the engine are told the same one
      expect([...f.asked]).toEqual([[a.sha, 1], [b.sha, 1]]);
    }).pipe(Effect.scoped),
  );
});

test("a message sent while the turn waits for a caption is logged before one sent during the run", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const seeing: TurnEngine = {
        ref: "seeing:x",
        run: (input, out) =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              const m = yield* input.mid.next;
              yield* out.took(m);
            }
            yield* out.log("talk", `reply ${calls}`);
          }),
        vision: true,
        warm: () => Effect.void,
      };
      const f = fakeMedia();
      const r = yield* rig([seeing], f.media);
      const a = image(1);
      yield* r.session.input("A", { clientId: "c1", media: [a] });
      yield* until("a's caption asked for", () => f.waiting.has(a.sha));
      yield* r.session.input("B, sent during the wait", { clientId: "c2" });
      f.describe(a, "caption A");
      yield* until("the call", () => calls === 1);
      yield* r.session.input("C, sent during the run", { clientId: "c3" });
      yield* until("both runs' ends", () => r.ended() === 2);
      expect(r.log()).toEqual([
        ["user", `A\n[image ${shortSha(a.sha)} 1568x1176 195KB: caption A]`],
        ["user", "B, sent during the wait"],
        ["talk", "reply 1"],
        ["user", "C, sent during the run"],
        ["talk", "reply 2"],
      ]);
    }).pipe(Effect.scoped),
  );
});

test("a mid-run message is offered with the caption it is logged with, though the caption comes after it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const mids: Mid[] = [];
      const seeing: TurnEngine = {
        ref: "seeing:x",
        run: (input, out) =>
          Effect.gen(function* () {
            const m = yield* input.mid.next;
            mids.push(m);
            yield* out.took(m);
          }),
        vision: true,
        warm: () => Effect.void,
      };
      const f = fakeMedia();
      const r = yield* rig([seeing], f.media);
      const later = image(3);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the call", () => r.session.state().engine === "seeing:x");
      yield* r.session.input("and this", { clientId: "c2", media: [later] });
      yield* until("its caption asked for", () => f.waiting.has(later.sha));
      expect(mids).toEqual([]); // not offered before its caption is in
      f.describe(later, "a green triangle");
      yield* until("the run's end", () => r.ended() === 1);
      const text = `and this\n[image ${shortSha(later.sha)} 1568x1176 195KB: a green triangle]`;
      expect(mids).toEqual([{ media: [PIC], seq: 2, text }]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["user", text],
      ]);
    }).pipe(Effect.scoped),
  );
});

test("a cancel while a caption is awaited loses nothing: the message is logged, with the wait over", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seeing: TurnEngine = { ref: "seeing:x", run: () => Effect.void, vision: true, warm: () => Effect.void };
      const f = fakeMedia();
      const r = yield* rig([seeing], f.media);
      const a = image(1);
      yield* r.session.input("look", { clientId: "c1", media: [a] });
      yield* until("the caption asked for", () => f.waiting.has(a.sha));
      yield* Effect.forkChild(r.session.cancel);
      f.describe(a, "late"); // the cancel's own wait ends with it
      yield* until("the run's end", () => r.log().length === 1);
      expect(r.log()).toEqual([["user", `look\n[image ${shortSha(a.sha)} 1568x1176 195KB: late]`]]);
    }).pipe(Effect.scoped),
  );
});
