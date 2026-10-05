// The read-only file tools of an engine that runs its own tool loop (SPEC "Engines", tools on
// non-Claude engines; M5): Read, Glob and Grep inside a device's folders, nothing that writes and
// no shell. Every path is resolved first (`~`, `..`, symlinks) and must land in one of the
// folders, as the device runner checks a spawn's cwd (SPEC "Multi-machine"). The device runner
// serves these on POST /tool; the server's own device runs the same code in-process.
import { Data, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { isAbsolute, resolve } from "node:path";
import { expandHome } from "../paths.ts";
import { type GrepJob, binary } from "./grep-search.ts";

export class Outside extends Data.TaggedError("Outside")<{ readonly message: string }> {}

const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);

// `path`'s real path when it is one of `folders` or inside one
export const confine = (path: string, folders: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const expanded = expandHome(path);
    if (!isAbsolute(expanded)) return yield* new Outside({ message: `${path} is not an absolute path` });
    const real = yield* fs.realPath(expanded).pipe(Effect.mapError(() => new Outside({ message: `${path} does not exist on this device` })));
    for (const folder of folders) {
      const root = yield* fs.realPath(expandHome(folder)).pipe(Effect.option);
      if (Option.isSome(root) && within(real, root.value)) return real;
    }
    return yield* new Outside({ message: `${path} is outside this device's folders` });
  });

const READ_LINES = 2000; // lines per Read unless `limit` says otherwise
const LINE_CHARS = 2000; // a longer line is cut
const READ_BYTES = 10_000_000; // a bigger file is refused: Grep it, or read it elsewhere
const GREP_BYTES = 1_000_000; // a bigger file is skipped by Grep
const OUTPUT = 100_000; // characters of output at most; the log keeps CAP of it
const MATCHES = 1000; // paths from Glob at most
export const TOOL_TIMEOUT = "30 seconds";
const GREP_WORKER = new URL("grep-worker.ts", import.meta.url);

// what the model gets to call: JSON schemas without descriptions inside, the tool's own text above
export type ToolDef = { readonly name: string; readonly description: string; readonly parameters: Schema.Json };

export const fileToolDefs = (o: { readonly device: string; readonly folders: readonly string[] }): ToolDef[] => {
  const where = `on the machine "${o.device}". Paths are absolute or relative to ${o.folders[0] ?? "~"}; only ${o.folders.join(", ")} can be read.`;
  return [
    {
      description: `Read a text file ${where} Lines come numbered; offset is the first line (1-based), limit how many (${READ_LINES} by default).`,
      name: "Read",
      parameters: {
        additionalProperties: false,
        properties: { file_path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } },
        required: ["file_path"],
        type: "object",
      },
    },
    {
      description: `List the files matching a glob pattern such as "src/**/*.ts" under path, newest first, ${where}`,
      name: "Glob",
      parameters: {
        additionalProperties: false,
        properties: { path: { type: "string" }, pattern: { type: "string" } },
        required: ["pattern"],
        type: "object",
      },
    },
    {
      description: `Search file contents with a JavaScript regular expression under path, optionally only files matching glob, ${where} output_mode: files_with_matches (default), content (path:line:text) or count.`,
      name: "Grep",
      parameters: {
        additionalProperties: false,
        properties: {
          case_insensitive: { type: "boolean" },
          glob: { type: "string" },
          output_mode: { enum: ["files_with_matches", "content", "count"], type: "string" },
          path: { type: "string" },
          pattern: { type: "string" },
        },
        required: ["pattern"],
        type: "object",
      },
    },
  ];
};

const ReadInput = Schema.Struct({ file_path: Schema.String, offset: Schema.optional(Schema.Int), limit: Schema.optional(Schema.Int) });
const GlobInput = Schema.Struct({ pattern: Schema.String, path: Schema.optional(Schema.String) });
const GrepInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
  glob: Schema.optional(Schema.String),
  case_insensitive: Schema.optional(Schema.Boolean),
  output_mode: Schema.optional(Schema.Literals(["files_with_matches", "content", "count"])),
});
const decodeRead = Schema.decodeUnknownOption(ReadInput);
const decodeGlob = Schema.decodeUnknownOption(GlobInput);
const decodeGrep = Schema.decodeUnknownOption(GrepInput);

class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

const failed = (cause: unknown) => new Refused({ message: cause instanceof Error ? cause.message : String(cause) });

// output cut at OUTPUT characters, saying so
const bounded = (lines: readonly string[]) => {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    size += line.length + 1;
    if (size > OUTPUT) return [...kept, `[… output cut at ${OUTPUT} characters …]`].join("\n");
    kept.push(line);
  }
  return kept.join("\n");
};

// a pattern stays below the folder it searches: no absolute patterns, no `..`
const relativePattern = (pattern: string) => !pattern.startsWith("/") && !pattern.startsWith("~") && !pattern.split("/").includes("..");

// The search runs in a Worker, so a pattern that backtracks without end blocks the worker and
// nothing else: the timeout (or an interrupt) terminates it.
const search = (job: GrepJob) =>
  Effect.callback<readonly string[], Refused>((resume) => {
    const worker = new Worker(GREP_WORKER);
    const done = (result: Effect.Effect<readonly string[], Refused>) => {
      worker.terminate();
      resume(result);
    };
    worker.addEventListener("message", (event: MessageEvent<{ readonly lines?: readonly string[]; readonly error?: string }>) => {
      const { lines, error } = event.data;
      done(lines === undefined ? Effect.fail(new Refused({ message: error ?? "the search failed" })) : Effect.succeed(lines));
    });
    worker.addEventListener("error", (event) => {
      done(Effect.fail(new Refused({ message: event.message })));
    });
    worker.postMessage(job);
    return Effect.sync(() => {
      worker.terminate();
    }); // interrupted: the timeout, a cancelled turn
  });

export type FileTools = (name: string, input: Schema.Json) => Effect.Effect<string>;

// The tools for one device's folders (as configured, `~` being this machine's home). Every
// failure is the tool's answer, as text: the model reads it and carries on.
export const makeFileTools = (folders: readonly string[], o: { readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const timeout = o.timeout ?? TOOL_TIMEOUT;
    const fs = yield* FileSystem.FileSystem;
    const home = expandHome(folders[0] ?? "~");
    const inside = (path: string) =>
      confine(isAbsolute(expandHome(path)) ? path : resolve(home, path), folders).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError((e) => new Refused({ message: e.message })),
      );
    // a file the glob found, still inside once symlinks are resolved; None when not
    const stillInside = (path: string) => inside(path).pipe(Effect.option);

    const read = (i: typeof ReadInput.Type) =>
      Effect.gen(function* () {
        const path = yield* inside(i.file_path);
        const info = yield* fs.stat(path).pipe(Effect.mapError(failed));
        if (info.type !== "File") return yield* new Refused({ message: `${i.file_path} is not a file` });
        if (Number(info.size) > READ_BYTES) return yield* new Refused({ message: `${i.file_path} is ${info.size} bytes, more than Read takes; Grep it instead` });
        const text = yield* fs.readFileString(path).pipe(Effect.mapError(failed));
        if (binary(text)) return yield* new Refused({ message: `${i.file_path} is a binary file` });
        if (text === "") return "(empty file)";
        const lines = text.split("\n");
        if (text.endsWith("\n")) lines.pop(); // a final newline ends the last line; it starts none
        const from = Math.max(1, i.offset ?? 1);
        const shown = lines.slice(from - 1, from - 1 + Math.max(1, i.limit ?? READ_LINES));
        return bounded(shown.map((line, k) => `${String(from + k).padStart(6)}\t${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}[…]` : line}`));
      });

    // the files under `base` matching `pattern`, each checked against the folders
    const scan = (base: string, pattern: string) =>
      Effect.gen(function* () {
        if (!relativePattern(pattern)) return yield* new Refused({ message: `the pattern ${pattern} must be relative to the path, without ..` });
        const found = yield* Effect.tryPromise({
          catch: failed,
          try: async (signal) => {
            const paths: string[] = [];
            for await (const p of new Bun.Glob(pattern).scan({ absolute: true, cwd: base, dot: false, followSymlinks: false, onlyFiles: true })) {
              if (signal.aborted || paths.length >= MATCHES * 10) break;
              if (!p.includes("/node_modules/")) paths.push(p);
            }
            return paths;
          },
        });
        const kept = yield* Effect.forEach(found, stillInside, { concurrency: 16 });
        return kept.flatMap((p) => Option.toArray(p));
      });

    const glob = (i: typeof GlobInput.Type) =>
      Effect.gen(function* () {
        const base = yield* inside(i.path ?? home);
        const paths = yield* scan(base, i.pattern);
        if (paths.length === 0) return "No files found";
        const dated = yield* Effect.forEach(paths, (p) => fs.stat(p).pipe(Effect.map((s) => ({ at: Option.getOrElse(s.mtime, () => new Date(0)).getTime(), p })), Effect.orElseSucceed(() => ({ at: 0, p }))), {
          concurrency: 16,
        });
        dated.sort((a, b) => b.at - a.at);
        const more = dated.length > MATCHES ? [`[… ${dated.length - MATCHES} more files …]`] : [];
        return bounded([...dated.slice(0, MATCHES).map((d) => d.p), ...more]);
      });

    const grep = (i: typeof GrepInput.Type) =>
      Effect.gen(function* () {
        const base = yield* inside(i.path ?? home);
        yield* Effect.try({ catch: (e) => new Refused({ message: `bad pattern: ${failed(e).message}` }), try: () => new RegExp(i.pattern, i.case_insensitive ? "i" : "") });
        const info = yield* fs.stat(base).pipe(Effect.mapError(failed));
        const files = info.type === "File" ? [base] : yield* scan(base, i.glob ?? "**/*");
        const lines = yield* search({ files, ignoreCase: i.case_insensitive === true, lineChars: LINE_CHARS, maxBytes: GREP_BYTES, mode: i.output_mode ?? "files_with_matches", outputChars: OUTPUT, pattern: i.pattern });
        return lines.length === 0 ? "No matches found" : bounded(lines);
      });

    const run: FileTools = (name, input) => {
      const call = (): Effect.Effect<string, Refused> => {
        switch (name) {
          case "Read":
            return Option.match(decodeRead(input), { onNone: () => Effect.fail(new Refused({ message: "Read needs file_path" })), onSome: read });
          case "Glob":
            return Option.match(decodeGlob(input), { onNone: () => Effect.fail(new Refused({ message: "Glob needs pattern" })), onSome: glob });
          case "Grep":
            return Option.match(decodeGrep(input), { onNone: () => Effect.fail(new Refused({ message: "Grep needs pattern" })), onSome: grep });
          default:
            return Effect.fail(new Refused({ message: `there is no tool named ${name}; this engine's tools only read` }));
        }
      };
      return call().pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new Refused({ message: `${name} took longer than ${Duration.format(Duration.fromInputUnsafe(timeout))}` })) }),
        Effect.catch((error) => Effect.succeed(`Error: ${error.message}`)),
      );
    };
    return run;
  });
