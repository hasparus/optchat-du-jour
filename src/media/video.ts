// Video (SPEC "Media"): no engine in our chains takes video, so a clip becomes what ChatGPT and
// Gemini make of one too: frames, plus a transcript of its audio. ffprobe reads its length, ffmpeg
// copies it without its metadata (a phone writes the place it was shot into the file) and takes
// at most MAX_FRAMES frames, one per 2 s, or spread evenly over a longer clip, at 768 px on the
// long edge. The audio is transcribed only by a local whisper named in the config
// (`media.whisper`); without one the clip goes on without a transcript, and says so. Audio is
// never sent to an outside service.
//
// The bytes are a stranger's, so every tool call is bounded: it may read the `file` protocol only
// (no URL, playlist or concat input can make ffmpeg fetch anything), the demuxer is the one the
// bytes were sniffed as instead of one ffmpeg guesses, it reads at most maxVideoSeconds of the
// clip, a picture past ~8K is refused before anything decodes it, and a call that runs past its
// time is killed.
import { Duration, Effect, Option, Schema } from "effect";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MediaError } from "./image.ts";
import { EXT } from "./sniff.ts";

export const MAX_FRAMES = 24;
export const FRAME_EDGE = 768;
const STEP = 2; // seconds between frames, for a clip short enough

// `limit`: seconds a call may take on top of the clip's own length (media.toolSeconds)
export type Tools = { readonly ffmpeg: string; readonly ffprobe: string; readonly whisper: readonly string[] | null; readonly limit: number };

// the demuxer each sniffed type is read with (ffmpeg names the MP4 family "mov", WebM "matroska")
const DEMUXER = { "video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska" } as const;
export type VideoMime = keyof typeof DEMUXER;
// before every input: the file protocol only, and the demuxer named
const intake = (mime: VideoMime) => ["-protocol_whitelist", "file", "-f", DEMUXER[mime]];

// a picture past this is refused: a frame is decoded whole, and ~8K is past any phone
export const MAX_EDGE = 8192;
export const MAX_PIXELS = 8192 * 4320;

// the tool ran and said no: the input was bad (422), where a tool that would not start is ours (500)
class Refused extends Error {}

// One command, its stdout; a non-zero exit fails with its stderr (422). Past `seconds` it is
// killed (422), and so it is when the call is interrupted.
const run = (argv: readonly string[], what: string, seconds: number) =>
  Effect.tryPromise({
    catch: (error) => new MediaError({ message: `${what}: ${error instanceof Error ? error.message : String(error)}`, status: error instanceof Refused ? 422 : 500 }),
    try: async (signal) => {
      const proc = Bun.spawn([...argv], { killSignal: "SIGKILL", signal, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code !== 0) throw new Refused(err.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`);
      return out;
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () => Effect.fail(new MediaError({ message: `${what}: it took longer than ${Math.round(seconds)} s`, status: 422 })),
    }),
  );

export type Probe = { readonly duration: number; readonly width: number; readonly height: number; readonly audio: boolean };

// what ffprobe's JSON says that is read here
const ProbeJson = Schema.Struct({
  format: Schema.optional(Schema.Struct({ duration: Schema.optional(Schema.NumberFromString) })),
  streams: Schema.optional(
    Schema.Array(Schema.Struct({ codec_type: Schema.optional(Schema.String), width: Schema.optional(Schema.Number), height: Schema.optional(Schema.Number) })),
  ),
});
const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(ProbeJson));

export const probe = (tools: Tools, path: string, mime: VideoMime): Effect.Effect<Probe, MediaError> =>
  run([tools.ffprobe, "-v", "error", ...intake(mime), "-print_format", "json", "-show_format", "-show_streams", path], "cannot read the video", tools.limit).pipe(
    Effect.flatMap((out) => {
      const parsed = Option.getOrUndefined(decodeProbe(out));
      const video = parsed?.streams?.find((s) => s.codec_type === "video");
      const duration = parsed?.format?.duration;
      if (!video?.width || !video.height || duration === undefined || !Number.isFinite(duration))
        return Effect.fail(new MediaError({ message: "cannot read the video: ffprobe found no video stream", status: 422 }));
      return Effect.succeed({ audio: parsed?.streams?.some((s) => s.codec_type === "audio") ?? false, duration, height: video.height, width: video.width });
    }),
  );

// the times frames are taken at: every STEP seconds, or MAX_FRAMES spread over a longer clip
export const frameTimes = (duration: number) => {
  const step = Math.max(STEP, duration / MAX_FRAMES);
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / step)));
  return { count, step };
};

// "0:14", "1:02:07"
export const clock = (t: number) => {
  const s = Math.floor(t);
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  const [h = 0, m = 0, sec = 0] = hms;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export type Extracted = {
  readonly clean: Uint8Array; // the clip, its metadata dropped, streams copied as they were
  readonly probe: Probe;
  readonly frames: readonly { readonly t: number; readonly data: Uint8Array }[]; // PNG, at most FRAME_EDGE on the long edge
  readonly transcript: string | null;
  readonly notice: string | null;
};

const TRANSCRIPT_MAX = 8000;

// everything a stored video needs, from the upload's bytes, in a temporary folder removed after
export const extract = (tools: Tools, bytes: Uint8Array, mime: VideoMime, maxSeconds: number): Effect.Effect<Extracted, MediaError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(`${tmpdir()}/optchat-video-`)),
    (dir) =>
      Effect.gen(function* () {
        const ext = EXT[mime];
        const input = `${dir}/in.${ext}`;
        writeFileSync(input, bytes);
        const p = yield* probe(tools, input, mime);
        if (p.width > MAX_EDGE || p.height > MAX_EDGE || p.width * p.height > MAX_PIXELS)
          return yield* new MediaError({ message: `the video is ${p.width}x${p.height}; at most ${MAX_EDGE} px on a side and ${MAX_PIXELS} px in all are taken`, status: 413 });
        if (p.duration > maxSeconds) return yield* new MediaError({ message: `the video is ${Math.round(p.duration)} s long; at most ${maxSeconds} s are taken`, status: 413 });
        // each call may take this long: a minute (media.toolSeconds) and the clip's length
        const seconds = tools.limit + p.duration;
        const reading = [...intake(mime), "-t", String(maxSeconds)];
        // the same streams without any metadata, bit-exact so the same upload gives the same file
        const clean = `${dir}/clean.${ext}`;
        const exact = ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"];
        yield* run(
          [tools.ffmpeg, "-v", "error", ...reading, "-i", input, "-map", "0:v", "-map", "0:a?", "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", ...exact, clean],
          "cannot copy the video",
          seconds,
        );
        const { count, step } = frameTimes(p.duration);
        const scale = `scale='min(${FRAME_EDGE},iw)':'min(${FRAME_EDGE},ih)':force_original_aspect_ratio=decrease`;
        yield* run(
          [tools.ffmpeg, "-v", "error", ...reading, "-i", input, "-vf", `fps=1/${step},${scale}`, "-frames:v", String(count), "-start_number", "0", `${dir}/f%03d.png`],
          "cannot take frames from the video",
          seconds,
        );
        const files = readdirSync(dir)
          .filter((f) => /^f\d{3}\.png$/.test(f))
          .toSorted();
        const frames = files.map((f, k) => ({ data: readFileSync(`${dir}/${f}`), t: k * step }));
        if (frames.length === 0) return yield* new MediaError({ message: "the video has no frames ffmpeg can read", status: 422 });
        const heard = yield* transcribe(tools, input, dir, { audio: p.audio, mime, seconds, maxSeconds });
        return { clean: readFileSync(clean), frames, notice: heard.notice, probe: p, transcript: heard.transcript };
      }),
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { force: true, recursive: true });
      }),
  );

// the audio as text, by the local whisper command with the 16 kHz mono WAV's path appended
const transcribe = (tools: Tools, input: string, dir: string, o: { readonly audio: boolean; readonly mime: VideoMime; readonly seconds: number; readonly maxSeconds: number }) =>
  Effect.gen(function* () {
    if (!o.audio) return { notice: null, transcript: null };
    if (tools.whisper === null || tools.whisper.length === 0)
      return { notice: "audio not transcribed: no local whisper is configured (media.whisper)", transcript: null };
    const wav = `${dir}/audio.wav`;
    yield* run(
      [tools.ffmpeg, "-v", "error", ...intake(o.mime), "-t", String(o.maxSeconds), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav],
      "cannot take the audio from the video",
      o.seconds,
    );
    const heard = yield* run([...tools.whisper, wav], "whisper failed", o.seconds).pipe(Effect.result);
    if (heard._tag === "Failure") return { notice: `audio not transcribed: ${heard.failure.message}`, transcript: null };
    const text = heard.success.trim();
    return { notice: null, transcript: text.length > TRANSCRIPT_MAX ? `${text.slice(0, TRANSCRIPT_MAX)}…` : text };
  });
