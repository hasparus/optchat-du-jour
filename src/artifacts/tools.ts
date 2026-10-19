// The artifact tools (SPEC "Artifacts"), from fx0 lib/tools.ts's publish_design, edit_design and
// read_design (Apache-2.0, © Vercel, modified): many artifacts by name instead of one design per
// chat. They sit on /mcp beside zoom and date for a claude-code turn and in the tool loop's box on
// the other engines; a subagent's calls of publish and edit are refused, as its spawn and tell are.
// Also the log's stubs (E31): what the log keeps of these calls instead of the HTML.
import { Clock, Effect, Option, Schema } from "effect";
import type { Entry, Mem } from "../tree.ts";
import { artifactTool, type ArtifactTool, type ArtifactVersion, splitTool } from "../wire.ts";
import { type Artifacts, kb, MAX_EDITS } from "./store.ts";
import { readStyle, STYLE_PREFIX, STYLES } from "./styles.ts";

// The three tools as MCP lists them; the tool loop offers the same (src/tools/box.ts). Nothing here
// changes from call to call: the list is part of every cached prefix, and adding them changed it
// once. Their input schemas carry no descriptions, as zoom's and date's don't (ref §9). Their
// properties are in the order a model writes them: the name first, so a live draft knows its
// artifact before the HTML streams in.
export const ARTIFACT_TOOL_DEFS = [
  {
    description:
      "Publish one complete self-contained HTML page as the artifact called name, as its next version; a new name makes a new artifact. The user sees it beside the chat, its scripts running in a sandboxed frame. It must start with <!doctype html> and hold one html, head and body; inline CSS and JavaScript only (Canvas, animation and event handlers work); images, fonts and media only as data: URLs; links only to #fragments or https pages, which open in a new tab. No HTML comments, script src, external assets, forms, iframes, objects, embeds, base, meta refresh or javascript: URLs. At most 512 KB; keep a first version under 12 KB. To change an artifact that exists, use edit_artifact. name: a letter, then up to 31 letters, digits, - or _.",
    inputSchema: { properties: { name: { type: "string" }, html: { type: "string" } }, required: ["name", "html"], type: "object" },
    name: "publish_artifact",
  },
  {
    description: `Apply exact replacements to the latest version of the artifact called name, saved as one new version. Put every change a request needs into one call: the edits apply in order, each old must match exactly once in the page as it stands after the edits before it, and if one doesn't, nothing is saved. 1 to ${MAX_EDITS} edits.`,
    inputSchema: {
      properties: {
        name: { type: "string" },
        edits: { items: { properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"], type: "object" }, type: "array" },
      },
      required: ["name", "edits"],
      type: "object",
    },
    name: "edit_artifact",
  },
  {
    description: `Read the HTML of the artifact called name: its latest version, or version. A long page comes a part at a time, from character from on. read_artifact("${STYLE_PREFIX}<id>") reads a design style to follow instead, one of: ${STYLES.map((s) => s.id).join(", ")}.`,
    inputSchema: { properties: { name: { type: "string" }, version: { type: "integer" }, from: { type: "integer" } }, required: ["name"], type: "object" },
    name: "read_artifact",
  },
] as const;

// characters of a page per read_artifact answer: under CAP, which the tool loop's model and the
// log's echo get at most
export const READ_PAGE = 28_000;
// how long a publish waits for its own tool call to reach the log (claude-code's stream is read
// beside the MCP request), so its version can name it; past that it names none
const CALL_WAIT = 2000;

export type ArtifactCall = (tool: ArtifactTool, args: Readonly<Record<string, Schema.Json>>) => Effect.Effect<{ readonly text: string; readonly error: boolean }>;
// the tools as a caller may use them: the master all three, a subagent read_artifact only
export type ArtifactTools = { readonly call: ArtifactCall };
export const noArtifacts: ArtifactTools = { call: (tool) => Effect.succeed({ error: true, text: `${tool}: there are no artifacts here.` }) };

const PublishArgs = Schema.Struct({ html: Schema.String, name: Schema.String });
const EditArgs = Schema.Struct({ edits: Schema.Array(Schema.Struct({ new: Schema.String, old: Schema.String })), name: Schema.String });
const ReadArgs = Schema.Struct({ from: Schema.optional(Schema.Number), name: Schema.String, version: Schema.optional(Schema.Number) });
const decodePublish = Schema.decodeUnknownOption(PublishArgs);
const decodeEdit = Schema.decodeUnknownOption(EditArgs);
const decodeRead = Schema.decodeUnknownOption(ReadArgs);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));

const ok = (text: string) => ({ error: false, text });
const refused = (text: string) => ({ error: true, text });
const dateOf = (iso: string) => iso.slice(0, 16).replace("T", " ");

// the artifact a logged publish or edit call names, from its input as logged (stub or not)
const decodeNamed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ name: Schema.String })));
const calledName = (e: Pick<Entry, "kind" | "text">): string | null => {
  if (e.kind !== "tool") return null;
  const { args, name } = splitTool(e.text);
  const tool = artifactTool(name);
  if (tool !== "publish_artifact" && tool !== "edit_artifact") return null;
  return Option.getOrNull(decodeNamed(args))?.name ?? null;
};

// The log index of the call that is making a version of `name` now: the newest publish or edit
// call of it in the log that no version names yet. On the tool loop it is logged before the call
// runs; on claude-code the MCP request and the stream race, so it is waited for, briefly.
const callOf = (mem: Mem, name: string, claimed: ReadonlySet<number>, wait: number) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + wait;
    for (;;) {
      for (let k = mem.root.length - 1; k >= Math.max(0, mem.root.length - 64); k--) {
        const e = mem.root[k];
        if (e && !claimed.has(e.i) && calledName(e)?.toLowerCase() === name.toLowerCase()) return e.i;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) return null;
      yield* Effect.sleep("25 millis");
    }
  });

// The tools over the store. `changed`: a new version was saved (clients are told). `mem`: the log,
// to name each version's call.
export const makeArtifactTools = (o: {
  readonly artifacts: Artifacts;
  readonly mem: Mem;
  readonly changed: (name: string, version: ArtifactVersion) => Effect.Effect<void>;
  readonly callWait?: number; // CALL_WAIT, in ms
}) => {
  const wait = o.callWait ?? CALL_WAIT;
  const claimed = (name: string) => new Set((o.artifacts.info(name)?.versions ?? []).flatMap((v) => (v.i === null ? [] : [v.i])));
  const saved = (verb: string) => (out: { readonly ok: true; readonly name: string; readonly version: ArtifactVersion; readonly changed: boolean }) =>
    out.changed
      ? o.changed(out.name, out.version).pipe(Effect.as(ok(`${verb} ${out.name} v${out.version.v} (${kb(out.version.bytes)}).`)))
      : Effect.succeed(ok(`${out.name} is unchanged: v${out.version.v} is this HTML already.`));

  const publish = (args: Readonly<Record<string, Schema.Json>>) =>
    Option.match(decodePublish(args), {
      onNone: () => Effect.succeed(refused("publish_artifact needs name and html, both strings.")),
      onSome: ({ html, name }) =>
        callOf(o.mem, name, claimed(name), wait).pipe(
          Effect.flatMap((at) => o.artifacts.publish(name, html, at)),
          Effect.flatMap((out) => (out.ok ? saved("Published")(out) : Effect.succeed(refused(`publish_artifact: ${out.error}`)))),
          Effect.catch((error) => Effect.succeed(refused(`publish_artifact: nothing was saved: ${error.message}`))),
        ),
    });

  const edit = (args: Readonly<Record<string, Schema.Json>>) =>
    Option.match(decodeEdit(args), {
      onNone: () => Effect.succeed(refused('edit_artifact needs name and edits, a list of {"old", "new"} strings.')),
      onSome: ({ edits, name }) =>
        callOf(o.mem, name, claimed(name), wait).pipe(
          Effect.flatMap((at) => o.artifacts.edit(name, edits, at)),
          Effect.flatMap((out) => (out.ok ? saved("Edited; saved")(out) : Effect.succeed(refused(`edit_artifact: ${out.error}`)))),
          Effect.catch((error) => Effect.succeed(refused(`edit_artifact: nothing was saved: ${error.message}`))),
        ),
    });

  const read = (args: Readonly<Record<string, Schema.Json>>) =>
    Option.match(decodeRead(args), {
      onNone: () => Effect.succeed(refused("read_artifact needs a name.")),
      onSome: ({ from = 0, name, version }) => {
        const start = Math.max(0, Math.floor(from));
        if (name.startsWith(STYLE_PREFIX)) {
          const style = readStyle(name.slice(STYLE_PREFIX.length));
          if (!style) return Effect.succeed(refused(`read_artifact: no style ${name}; the styles are ${STYLES.map((s) => `${STYLE_PREFIX}${s.id}`).join(", ")}`));
          return Effect.succeed(ok(page(`${STYLE_PREFIX}${style.option.id}, the ${style.option.name} style (${kb(Buffer.byteLength(style.text))})`, style.text, start)));
        }
        return o.artifacts.read(name, version).pipe(
          Effect.map((found) => {
            if (found === null) {
              const known = o.artifacts.info(name);
              return refused(known ? `read_artifact: ${known.name} has no version ${version ?? ""}; it has v1 to v${known.versions.at(-1)?.v ?? 0}` : `read_artifact: there is no artifact named ${name}`);
            }
            const head = `${found.name} v${found.version.v} of ${found.latest} (${kb(found.version.bytes)}, ${dateOf(found.version.date)})`;
            return ok(page(head, found.html, start));
          }),
          Effect.catch((error) => Effect.succeed(refused(`read_artifact: ${error.message}`))),
        );
      },
    });

  return {
    tools: (caller: "master" | "subagent"): ArtifactTools => ({
      call: (tool, args) => {
        if (tool === "read_artifact") return read(args);
        if (caller === "subagent") return Effect.succeed(refused(`${tool}: a subagent reads artifacts and changes none.`));
        return tool === "publish_artifact" ? publish(args) : edit(args);
      },
    }),
  };
};

// A part of a long text, from character `from`, under a head line that says what it is and where
// the rest starts; the whole text when it fits
const page = (head: string, text: string, from: number) => {
  const part = text.slice(from, from + READ_PAGE);
  const end = from + part.length;
  const where = from === 0 && end >= text.length ? "" : `, characters ${from} to ${end} of ${text.length}${end < text.length ? `; read_artifact with from ${end} for the rest` : ""}`;
  return `${head}${where}:\n${part}`;
};

// ---------------------------------------------------------------------------------------------
// The log's stubs (E31). A publish or an edit carries up to 512 KB of HTML in its input, and a
// read in its answer; logged whole, it would be in the tree and in every view until summarized,
// and summarized it would cost a compaction per 512 bytes of markup. So the log keeps a stub:
// the call's input with the HTML (or the edits) replaced by its size, and a read's answer cut to
// its head line. The model reads the page again with read_artifact; the version is in the echo.

// what a stub says of a publish's HTML and an edit's edits, when they are what they should be
const decodeHtml = Schema.decodeUnknownOption(Schema.Struct({ html: Schema.String }));
const decodeEditList = Schema.decodeUnknownOption(Schema.Struct({ edits: Schema.Array(Schema.Json) }));
const htmlStub = (html: string) => `<${kb(Buffer.byteLength(html))} of HTML, not kept in the log: read_artifact>`;
const editsStub = (edits: readonly Schema.Json[]) =>
  `<${edits.length} edit${edits.length === 1 ? "" : "s"}, ${kb(Buffer.byteLength(JSON.stringify(edits)))}, not kept in the log: read_artifact>`;

// What the log keeps of a tool entry: a publish's or an edit's input with its HTML or its edits
// replaced by their size, its other keys as they came (whatever the model put there, malformed
// too, has a stub: nothing of a page's size goes in); any other tool entry, as it came.
export const stubToolEntry = (text: string): string => {
  const { args, name } = splitTool(text);
  const tool = artifactTool(name);
  if (tool !== "publish_artifact" && tool !== "edit_artifact") return text;
  const input = Option.getOrUndefined(decodeJson(args));
  if (input === undefined) return `${name} <${kb(Buffer.byteLength(args))} of input, not kept in the log>`;
  const html = Option.getOrUndefined(decodeHtml(input))?.html;
  const edits = Option.getOrUndefined(decodeEditList(input))?.edits;
  const stubbed = Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (key === "html") return [key, html === undefined ? `<${kb(Buffer.byteLength(JSON.stringify(value)))}, not kept in the log>` : htmlStub(html)];
      if (key === "edits") return [key, edits === undefined ? `<${kb(Buffer.byteLength(JSON.stringify(value)))}, not kept in the log>` : editsStub(edits)];
      return [key, value];
    }),
  );
  return `${name} ${JSON.stringify(stubbed)}`;
};

// what the log keeps of an echo: a read_artifact answer as its head line only; any other, as it came
export const stubEcho = (tool: string | undefined, text: string): string => {
  if (tool === undefined || artifactTool(tool) !== "read_artifact") return text;
  const line = text.indexOf("\n");
  if (line === -1) return text;
  return `${text.slice(0, line)}\n<${kb(Buffer.byteLength(text) - line - 1)} not kept in the log: read_artifact again>`;
};

// what the log (or a subagent's side log) keeps of an entry an engine reports: E31's stubs for the
// artifact tools, every other entry as it came. `tool`: for an echo, the tool it answers.
export const loggedText = (kind: string, body: string, tool?: string): string => (kind === "tool" ? stubToolEntry(body) : kind === "echo" ? stubEcho(tool, body) : body);
