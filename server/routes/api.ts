// /api/* (SPEC "Server, WebSocket API and CLI"): read-only JSON for the web UI and the REPL, and one
// write, POST /api/messages, a message answered once by its id (E41). Each body is encoded through
// its schema in src/wire.ts, the one the clients decode it with.
import { Effect, Option, Schema } from "effect";
import { type HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { claudeBinary, claudeVersion } from "../../src/claude/process.ts";
import type { Settings } from "../../src/config.ts";
import { viewLine } from "../../src/memory-view.ts";
import type { Reasoning } from "../../src/reasoning.ts";
import type { Session } from "../../src/session.ts";
import type { Subagents } from "../../src/subagents.ts";
import type { Mem } from "../../src/tree.ts";
import { readUsage } from "../../src/usage.ts";
import { render, viewSize } from "../../src/view.ts";
import { Devices, MessagesPage, PostMessage, ReasoningHeads, ReasoningPiece, Received, SessionState, SubagentLog, Usage, View } from "../../src/wire.ts";
import { deviceStatuses, versionWarning } from "../devices.ts";
import { type Assets, takeMessage } from "../messages.ts";

const Before = Schema.Struct({ before: Schema.optional(Schema.NumberFromString), limit: Schema.optional(Schema.NumberFromString) });
const Index = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
// a range of log indexes, at most MAX_RANGE wide (a page of the chat is far less)
const Range = Schema.Struct({ from: Index, to: Index });
const MAX_RANGE = 5000;
const At = Schema.Struct({ i: Index });
const Named = Schema.Struct({ name: Schema.String, from: Schema.optional(Index), limit: Schema.optional(Index) });
// a subagent's entries per /api/subagent answer unless the client asks for fewer (or more)
const SIDE_LIMIT = 100;
const decodePost = Schema.decodeUnknownOption(Schema.fromJsonString(PostMessage));
const badRequest = () => HttpServerResponse.empty({ status: 400 });
const serverError = () => HttpServerResponse.empty({ status: 500 });

export const apiRoutes = (
  router: HttpRouter.HttpRouter,
  o: {
    readonly session: Session;
    readonly mem: Mem;
    readonly reasoning: Reasoning; // the thinking kept beside the log (SPEC "Reasoning")
    readonly usagePath: string;
    readonly settings: Settings;
    readonly device: string; // this machine
    readonly report: (message: string) => Effect.Effect<void>;
    readonly subagents?: Pick<Subagents, "log">; // SPEC M7a: a subagent and its side log
    readonly assets: Assets; // a posted message's attachments (SPEC "Media")
  },
) =>
  Effect.gen(function* () {
    const { mem } = o;
    yield* router.add("GET", "/api/state", Effect.suspend(() => HttpServerResponse.schemaJson(SessionState)(o.session.state())));

    // a subagent and its side log from entry `from` on, `limit` entries at most (100 unless asked),
    // for its card (SPEC M7a); 404 for a name the server doesn't know
    yield* router.add("GET", "/api/subagent", () =>
      Effect.gen(function* () {
        const query = yield* HttpServerRequest.schemaSearchParams(Named).pipe(Effect.result);
        if (query._tag === "Failure") return badRequest();
        // `from`: the entries a client has already are not sent again; `limit`: a page at a time
        const { from = 0, limit = SIDE_LIMIT, name } = query.success;
        const found = o.subagents?.log(name, from, limit) ?? null;
        if (found === null) return HttpServerResponse.empty({ status: 404 });
        return yield* HttpServerResponse.schemaJson(SubagentLog)(found).pipe(Effect.orElseSucceed(serverError));
      }),
    );

    // the log, a page at a time, newest last; `before` is a message id
    yield* router.add("GET", "/api/messages", () =>
      Effect.gen(function* () {
        // a query that doesn't parse is the client's mistake (400); a body that doesn't encode is ours (500)
        const query = yield* HttpServerRequest.schemaSearchParams(Before).pipe(Effect.result);
        if (query._tag === "Failure") return badRequest();
        const q = query.success;
        const end = Math.min(q.before ?? mem.root.length, mem.root.length);
        const start = Math.max(0, end - (q.limit ?? 100));
        return yield* HttpServerResponse.schemaJson(MessagesPage)({ entries: mem.root.slice(start, end), total: mem.root.length }).pipe(Effect.orElseSucceed(serverError));
      }),
    );

    // A message from outside the app (E41): iOS Shortcuts, a share extension. As /ws takes one, and
    // answered once by its client's id: a retry is told what became of it (src/wire.ts Received)
    // and is not taken again. A body that doesn't decode, or that has nothing to send, is a 400;
    // one left with nothing to send once the attachments the server doesn't hold are left out is
    // refused, a 422 with the receipt saying why. Apart on purpose: a 400 can never be taken as it
    // is, a 422 can once its upload is there (uploaded again, then retried under the same id).
    yield* router.add("POST", "/api/messages", (request) =>
      Effect.gen(function* () {
        const body = decodePost(yield* request.text.pipe(Effect.orElseSucceed(() => ""))); // a body cut short reads as none
        if (Option.isNone(body)) return badRequest();
        const { attachments = [], ...m } = body.value;
        if (m.text.trim() === "" && attachments.length === 0) return badRequest();
        const answer = yield* takeMessage(o.session, o.assets, { ...m, attachments });
        const status = answer.outcome === "refused" ? 422 : 200;
        return yield* HttpServerResponse.schemaJson(Received)(answer, { status }).pipe(Effect.orElseSucceed(serverError));
      }),
    );

    // The thinking kept before the entries in [from, to), without its text, for the rows a page
    // shows; the text of one piece when the reader opens it (SPEC "Reasoning")
    yield* router.add("GET", "/api/reasoning", () =>
      Effect.gen(function* () {
        const query = yield* HttpServerRequest.schemaSearchParams(Range).pipe(Effect.result);
        if (query._tag === "Failure" || query.success.to < query.success.from || query.success.to - query.success.from > MAX_RANGE) return badRequest();
        const { from, to } = query.success;
        return yield* HttpServerResponse.schemaJson(ReasoningHeads)({ pieces: o.reasoning.heads(from, to) }).pipe(Effect.orElseSucceed(serverError));
      }),
    );
    yield* router.add("GET", "/api/reasoning/text", () =>
      Effect.gen(function* () {
        const query = yield* HttpServerRequest.schemaSearchParams(At).pipe(Effect.result);
        if (query._tag === "Failure") return badRequest();
        const piece = yield* o.reasoning.piece(query.success.i);
        if (piece === null) return HttpServerResponse.empty({ status: 404 });
        return yield* HttpServerResponse.schemaJson(ReasoningPiece)(piece).pipe(Effect.orElseSucceed(serverError));
      }),
    );

    // what the model sees, as the REPL's `view` prints it: each view line with its range, dates
    // and size (src/memory-view.ts viewLine, the memory view's line), and the view rendered
    yield* router.add(
      "GET",
      "/api/view",
      Effect.suspend(() =>
        HttpServerResponse.schemaJson(View)({ budget: mem.marks.high, lines: mem.view.map((c) => viewLine(mem, c)), size: viewSize(mem), text: render(mem) }),
      ).pipe(Effect.orElseSucceed(serverError)),
    );

    yield* router.add(
      "GET",
      "/api/usage",
      Effect.suspend(() => HttpServerResponse.schemaJson(Usage)(readUsage(o.usagePath))).pipe(Effect.orElseSucceed(serverError)),
    );

    // which devices answer and which claude they run (../devices.ts)
    const localVersion = yield* Effect.cachedWithTTL(claudeVersion(claudeBinary()), "10 minutes");
    let warned = "";
    yield* router.add(
      "GET",
      "/api/devices",
      Effect.gen(function* () {
        const list = yield* deviceStatuses({ devices: o.settings.devices, localVersion, self: o.device });
        const warning = versionWarning(list);
        if (warning && warning.key !== warned) {
          warned = warning.key;
          yield* o.report(warning.message);
        }
        return yield* HttpServerResponse.schemaJson(Devices)(list);
      }).pipe(Effect.orElseSucceed(serverError)),
    );
  });
