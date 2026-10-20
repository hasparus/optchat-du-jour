// /api/memory/* (E46, E47; SPEC "Web UI", Memory): the memory view, read a page at a time. The view's
// lines as of the feed's last change, and a node opened in place, its descendants a level or more
// down. The live changes go over /ws (../memory-feed.ts); these are what a client reads to start
// with, to fill what a change left out, and on opening a summary.
import { Effect, Schema } from "effect";
import { type HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { childrenPage, type Counted, viewPage } from "../../src/memory-view.ts";
import type { Mem } from "../../src/tree.ts";
import { MEMORY_MAX_LINES, MemoryChildren, MemoryPage } from "../../src/wire.ts";

const Count = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Limit = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: MEMORY_MAX_LINES, minimum: 1 }));
const ViewQuery = Schema.Struct({ before: Schema.optional(Count), limit: Schema.optional(Limit) });
// a node's level and index (a level whose span 2^l is still a safe integer), how deep to open it,
// and which of its descendants
const ChildrenQuery = Schema.Struct({
  i: Count,
  l: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 52, minimum: 0 })),
  depth: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 52, minimum: 1 }))),
  from: Schema.optional(Count),
  limit: Schema.optional(Limit),
});
const badRequest = () => HttpServerResponse.empty({ status: 400 });
const serverError = () => HttpServerResponse.empty({ status: 500 });

export const memoryRoutes = (router: HttpRouter.HttpRouter, o: { readonly mem: Mem; readonly at: () => Counted }) =>
  Effect.gen(function* () {
    // the view's lines before `before` (all: the newest), `limit` at most (100 unless asked, 500 at most)
    yield* router.add("GET", "/api/memory/view", () =>
      Effect.gen(function* () {
        const query = yield* HttpServerRequest.schemaSearchParams(ViewQuery).pipe(Effect.result);
        if (query._tag === "Failure") return badRequest();
        const { before, limit } = query.success;
        return yield* HttpServerResponse.schemaJson(MemoryPage)(viewPage(o.mem, o.at(), before, limit)).pipe(Effect.orElseSucceed(serverError));
      }),
    );
    // Node (l, i) opened `depth` levels down (1 unless asked: its two halves), its descendants from
    // the `from`-th, `limit` at most. 404 for a node the log doesn't reach yet; 400 for a depth past
    // its level (a message is read whole from /api/messages)
    yield* router.add("GET", "/api/memory/children", () =>
      Effect.gen(function* () {
        const query = yield* HttpServerRequest.schemaSearchParams(ChildrenQuery).pipe(Effect.result);
        if (query._tag === "Failure") return badRequest();
        const { depth = 1, from, i, l, limit } = query.success;
        if (depth > l) return badRequest();
        const page = childrenPage(o.mem, { i, l }, depth, from, limit);
        if (page === null) return HttpServerResponse.empty({ status: 404 });
        return yield* HttpServerResponse.schemaJson(MemoryChildren)(page).pipe(Effect.orElseSucceed(serverError));
      }),
    );
  });
