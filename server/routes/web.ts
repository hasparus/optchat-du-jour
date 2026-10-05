// / (SPEC "Web UI"): the built web UI as static files. Any other path is the app's (it has no
// router), except a missing file under /assets/: a stale page asking for a chunk an old build had
// must fail, not get HTML.
import { Effect } from "effect";
import { type HttpRouter, HttpServerResponse } from "effect/http";
import { existsSync } from "node:fs";

export const webRoute = (router: HttpRouter.HttpRouter, web: string | undefined) =>
  web === undefined || !existsSync(`${web}/index.html`)
    ? Effect.void
    : router.add("GET", "/*", (request) =>
        Effect.gen(function* () {
          const path = new URL(request.url, "http://x").pathname;
          const file = `${web}${path}`;
          const found = !path.includes("..") && path !== "/" && existsSync(file);
          if (!found && path.startsWith("/assets/")) return HttpServerResponse.empty({ status: 404 });
          return yield* HttpServerResponse.file(found ? file : `${web}/index.html`);
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 }))),
      );
