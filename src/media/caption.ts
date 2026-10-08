// Captions (SPEC "Media"): one cheap vision call per attachment says in a line what it shows, for
// the marker the log keeps. Later turns and the compactor see only that line, so it is the
// attachment's memory. The engines form a chain like the compactor's (`media.caption`, default
// claude-code:haiku) and fail over the same way; a caption that can't be had is "(not described)",
// never a guess. A video is described from its contact sheet and the start of its transcript.
import { Duration, Effect } from "effect";
import { baseArgs } from "../claude/args.ts";
import { Runner } from "../claude/process.ts";
import type { ProviderRef, Ref } from "../config.ts";
import { failover, watchChain } from "../engines/chain.ts";
import { type EngineError, fromResult, ModelError, UsageLimit } from "../engines/errors.ts";
import { type EngineNeeds, providerOf } from "../engines/registry.ts";
import { CAPTION } from "../prompts.ts";
import { headOf } from "../text.ts";
import { tokensOf, type Tokens, type UsageRecord } from "../usage.ts";
import { cleanCaption } from "../wire.ts";
import type { Picture } from "./part.ts";

export type CaptionInput = { readonly picture: Picture; readonly heard: string | null }; // heard: a video's transcript
export type Describe = (input: CaptionInput, failoverFrom: string | null) => Effect.Effect<string, EngineError>;

const CAPTION_TIMEOUT = "90 seconds";
const ASK = "Describe this image in one line.";
const askOf = (input: CaptionInput) => (input.heard ? `${ASK}\nIts audio, transcribed: ${headOf(input.heard, 600)}` : ASK);

// one record per caption call, as every model call gets (E11)
const record = (o: { engine: UsageRecord["engine"]; auth: UsageRecord["auth"]; model: string | null; usage: Tokens; failoverFrom: string | null; started: number; device: string | null; dollars?: number | undefined }): UsageRecord => {
  const now = Date.now();
  return {
    attempt: 1,
    auth: o.auth,
    cold: false, // nothing of a caption is cached
    date: new Date(now).toISOString(),
    device: o.device,
    dollars: o.dollars,
    engine: o.engine,
    failoverFrom: o.failoverFrom,
    level: null,
    model: o.model,
    ms: now - o.started,
    role: "caption",
    usage: o.usage,
  };
};

export type CaptionNeeds = EngineNeeds & { readonly runner: Runner["Service"]; readonly device: string; readonly planImages: boolean };

// `claude -p` with no tools and no settings, its own system prompt, the image and the ask in one
// stream-json message; the result's text is the caption
const claudeCodeCaption = (model: string, effort: string | undefined, o: CaptionNeeds): Describe => {
  const args = [...baseArgs({ effort, model, system: CAPTION, tools: "" }), "--safe-mode"];
  return (input, failoverFrom) =>
    Effect.gen(function* () {
      const started = Date.now();
      const claude = yield* o.runner.spawn({ args, env: { DISABLE_PROMPT_CACHING: "1" } }).pipe(Effect.mapError((e) => new ModelError({ message: e.message })));
      const { picture } = input;
      yield* claude.send([
        { source: { data: picture.data, media_type: picture.mime, type: "base64" }, type: "image" },
        { text: askOf(input), type: "text" },
      ]);
      const result = yield* claude.result.pipe(Effect.mapError((e) => new ModelError({ message: e.message })));
      const usage = tokensOf(result.usage);
      yield* o.log(record({ auth: "claude-max", device: o.device, engine: "claude-code", failoverFrom, model: claude.model() ?? model, started, usage }));
      if (result.is_error || result.stop_reason === "refusal") return yield* fromResult(result.result ?? "the caption call failed", result.stop_reason);
      return result.result ?? "";
    }).pipe(Effect.scoped);
};

// an engine with a provider: one request with the image and the ask, no tools
const providerCaption = (ref: ProviderRef, o: CaptionNeeds): Describe => {
  const provider = providerOf(ref, o, ref.effort);
  return (input, failoverFrom) =>
    Effect.gen(function* () {
      if (ref.engine === "openai-plan" && !o.planImages) return yield* new UsageLimit({ message: "openai-plan is not sent images (media.planImages is off)" });
      const p = yield* provider;
      const started = Date.now();
      const step = yield* p.call({ final: true, history: [{ parts: [input.picture, askOf(input)], type: "user" }], instructions: CAPTION, onText: () => Effect.void, tools: [] });
      yield* o.log(record({ auth: p.auth, device: o.device, dollars: step.dollars, engine: p.engine, failoverFrom, model: step.model, started, usage: step.usage }));
      return step.items.flatMap((i) => (i.type === "text" ? [i.text] : [])).join(" ");
    });
};

// The chain: the first engine that answers describes it; a spent plan or an offline device moves
// on, as for the compactor. Each engine going down and coming back is told once.
export const makeCaptioner = (refs: readonly Ref[], o: CaptionNeeds) => {
  const links = refs.map((ref) => ({ describe: ref.engine === "claude-code" ? claudeCodeCaption(ref.model, ref.effort, o) : providerCaption(ref, o), ref: ref.ref }));
  const watcher = watchChain(o.report, "captions");
  return (input: CaptionInput): Effect.Effect<string, EngineError> =>
    failover(
      links.map((l) => ({ ref: l.ref, run: (from: string | null) => l.describe(input, from) })),
      watcher,
    ).pipe(
      Effect.map(cleanCaption),
      Effect.timeoutOrElse({
        duration: CAPTION_TIMEOUT,
        orElse: () => Effect.fail(new ModelError({ message: `no caption within ${Duration.format(Duration.fromInputUnsafe(CAPTION_TIMEOUT))}` })),
      }),
    );
};
export type Captioner = ReturnType<typeof makeCaptioner>;
