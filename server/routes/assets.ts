// /api/assets (SPEC "Media"): bytes over HTTP, the message over the WebSocket. PUT stores an upload
// (its body is the file) and answers what it became; GET serves a stored asset, or with /thumb
// what shows it small (the image itself, or a video's contact sheet). Both sit behind the same
// guard as every route; a GET names an asset only by its digest or the 12-character prefix a
// marker carries, so nothing a model wrote can make the page fetch anything else. A GET takes a
// `Range` (one byte range), which iOS Safari needs to play a video.
import { Effect } from "effect";
import { type HttpRouter, HttpRouter as Router, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { MediaSettings } from "../../src/config.ts";
import type { Media } from "../../src/media/media.ts";
import { Asset } from "../../src/wire.ts";

// a stored asset never changes under its name
const IMMUTABLE = { "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" };

const refuse = (status: number, message: string) => HttpServerResponse.text(message, { status });

// What a Range header asks of a file of `size` bytes: its first and last byte (inclusive), "none"
// when there is no header or it is one this does not answer (several ranges, another unit, a
// malformed one: the whole file is sent then, as RFC 9110 allows), or "unsatisfiable".
export const rangeOf = (header: string | undefined, size: number) => {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "none" as const;
  if (m[1] === "") {
    const last = Number(m[2]); // the final `last` bytes
    return last === 0 || size === 0 ? ("unsatisfiable" as const) : { end: size - 1, start: Math.max(0, size - last) };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== "" && Number(m[2]) < start) return "none" as const;
  return start >= size ? ("unsatisfiable" as const) : { end, start };
};

export const assetRoutes = (router: HttpRouter.HttpRouter, o: { readonly media: Media; readonly settings: MediaSettings }) =>
  Effect.gen(function* () {
    const { media } = o;
    // Bun refuses a body over its own limit before this route runs (server/app.ts sets it from
    // these two); this tells a client that says how big it is, with a message.
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
        const request = yield* HttpServerRequest.HttpServerRequest;
        const found = media.find(id);
        const shown = found?.kind === "video" && thumb ? media.find(found.sheet) : found;
        const file = shown ? media.store.file(shown) : null;
        if (!file) return HttpServerResponse.empty({ status: 404 });
        const { size } = Bun.file(file.path);
        const headers = { ...IMMUTABLE, "accept-ranges": "bytes" };
        const range = rangeOf(request.headers.range, size);
        if (range === "none") return yield* HttpServerResponse.file(file.path, { contentType: file.mime, headers });
        if (range === "unsatisfiable") return HttpServerResponse.empty({ headers: { "content-range": `bytes */${size}` }, status: 416 });
        return yield* HttpServerResponse.file(file.path, {
          bytesToRead: range.end - range.start + 1,
          contentType: file.mime,
          headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}` },
          offset: range.start,
          status: 206,
        });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })));
    yield* router.add("GET", "/api/assets/:id", serve(false));
    yield* router.add("GET", "/api/assets/:id/thumb", serve(true));
  });
