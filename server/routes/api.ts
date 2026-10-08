// /api/* (SPEC "Server, WebSocket API and CLI"): read-only JSON for the web UI and the REPL. Each
// body is encoded through its schema in src/wire.ts, the one the clients decode it with.
import { Effect, Schema } from "effect";
import { type HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { claudeBinary, claudeVersion } from "../../src/claude/process.ts";
import type { Settings } from "../../src/config.ts";
import { openNode } from "../../src/mcp.ts";
import type { Session } from "../../src/session.ts";
import { getNode, localTime, type Mem } from "../../src/tree.ts";
import { readUsage } from "../../src/usage.ts";
import { PLACEHOLDER, render, viewSize } from "../../src/view.ts";
import { Devices, MessagesPage, NodeView, SessionState, span, Usage, View } from "../../src/wire.ts";
import { deviceStatuses, versionWarning } from "../devices.ts";

const Before = Schema.Struct({ before: Schema.optional(Schema.NumberFromString), limit: Schema.optional(Schema.NumberFromString) });
// a node's level and index: integers, and a level whose span 2^l is still a safe integer
const NodeAt = Schema.Struct({
  i: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  l: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 52, minimum: 0 })),
});
const badRequest = () => HttpServerResponse.empty({ status: 400 });
const serverError = () => HttpServerResponse.empty({ status: 500 });

export const apiRoutes = (
  router: HttpRouter.HttpRouter,
  o: {
    readonly session: Session;
    readonly mem: Mem;
    readonly usagePath: string;
    readonly settings: Settings;
    readonly device: string; // this machine
    readonly report: (message: string) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const { mem } = o;
    yield* router.add("GET", "/api/state", Effect.suspend(() => HttpServerResponse.schemaJson(SessionState)(o.session.state())));

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

    // what the model sees: each view line with its range, dates and size (SPEC "Web UI", Memory)
    yield* router.add(
      "GET",
      "/api/view",
      Effect.suspend(() =>
        HttpServerResponse.schemaJson(View)({
          budget: mem.marks.high,
          lines: mem.view.map((c) => {
            const node = getNode(mem, c);
            const { n, id } = span(c);
            const from = mem.root[id], to = mem.root[id + n - 1];
            return {
              built: node !== undefined,
              from: from ? localTime(from.date) : null,
              id,
              l: c.l,
              i: c.i,
              n,
              size: node?.size ?? null,
              text: node?.text ?? PLACEHOLDER,
              to: to ? localTime(to.date) : null,
            };
          }),
          size: viewSize(mem),
          text: render(mem),
        }),
      ).pipe(Effect.orElseSucceed(serverError)),
    );

    // one node and its two children, down to the message (the memory browser's zoom, as mcp.ts opens it)
    yield* router.add("GET", "/api/node", () =>
      Effect.gen(function* () {
        const at = yield* HttpServerRequest.schemaSearchParams(NodeAt).pipe(Effect.result);
        if (at._tag === "Failure") return badRequest();
        const { i, l } = at.success;
        const { id, n } = span({ i, l });
        const found = openNode(mem, id, n);
        if (!found) return HttpServerResponse.empty({ status: 404 });
        const node: NodeView =
          "message" in found
            ? { date: localTime(found.message.date), i, id, kind: found.message.kind, l: 0, n, text: found.message.text }
            : {
                children: found.halves.map((h) => ({ built: h.node !== undefined, i: h.at.i, l: h.at.l, text: h.node?.text ?? null })),
                i,
                id,
                l,
                n,
                text: found.node?.text ?? null,
              };
        return yield* HttpServerResponse.schemaJson(NodeView)(node).pipe(Effect.orElseSucceed(serverError));
      }),
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
