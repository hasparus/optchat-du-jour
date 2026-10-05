// /api/assets (SPEC "Media"): bytes over HTTP, the message over the WebSocket. PUT stores an upload
// (its body is the file) and answers what it became; GET serves a stored asset, or with /thumb
// what shows it small (the image itself, or a video's contact sheet). Both sit behind the same
// guard as every route; a GET names an asset only by its digest or the 12-character prefix a
// marker carries, so nothing a model wrote can make the page fetch anything else.
import { Effect } from "effect";
import { type HttpRouter, HttpRouter as Router, HttpServerResponse } from "effect/http";
import type { MediaSettings } from "../../src/config.ts";
import type { Media } from "../../src/media/media.ts";
import { Asset } from "../../src/wire.ts";

// a stored asset never changes under its name
const IMMUTABLE = { "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" };

const refuse = (status: number, message: string) => HttpServerResponse.text(message, { status });

export const assetRoutes = (router: HttpRouter.HttpRouter, o: { readonly media: Media; readonly settings: MediaSettings }) =>
  Effect.gen(function* () {
    const { media } = o;
    const most = Math.max(o.settings.maxImageBytes, o.settings.maxVideoBytes);

    yield* router.add("PUT", "/api/assets", (request) =>
      Effect.gen(function* () {
        // too big is told before the body is read, when the client says how big
        const declared = Number(request.headers["content-length"] ?? Number.NaN);
        if (declared > most) return refuse(413, `the upload is ${declared} bytes; at most ${most} are taken`);
        const tier = new URL(request.url, "http://x").searchParams.get("detail") === "high" ? "high" : "standard";
        const body = new Uint8Array(yield* request.arrayBuffer);
        const stored = yield* media.ingest(body, tier).pipe(Effect.result);
        if (stored._tag === "Failure") return refuse(stored.failure.status, stored.failure.message);
        return yield* HttpServerResponse.schemaJson(Asset)(stored.success);
      }).pipe(Effect.orElseSucceed(() => refuse(400, "the upload could not be read"))),
    );

    const serve = (thumb: boolean) =>
      Effect.gen(function* () {
        const { id = "" } = yield* Router.params;
        const found = media.find(id);
        const shown = found?.kind === "video" && thumb ? media.find(found.sheet) : found;
        const file = shown ? media.store.file(shown) : null;
        if (!file) return HttpServerResponse.empty({ status: 404 });
        return yield* HttpServerResponse.file(file.path, { contentType: file.mime, headers: IMMUTABLE });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })));
    yield* router.add("GET", "/api/assets/:id", serve(false));
    yield* router.add("GET", "/api/assets/:id/thumb", serve(true));
  });
