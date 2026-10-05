// /mcp (E8): zoom and date as an MCP server, over a WebSocket (a GET that upgrades, one JSON-RPC
// message per text frame each way) or one POST per message. tailscale serve hides the peer, so the
// URL carries a secret, made at startup and sent only inside --mcp-config.
import { Effect } from "effect";
import { type HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { forbidden } from "../../src/http.ts";
import { handleMcp } from "../../src/mcp.ts";
import type { Mem } from "../../src/tree.ts";

export const mcpRoutes = (router: HttpRouter.HttpRouter, o: { readonly mem: Mem; readonly secret: string }) => {
  const keyed = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://x").searchParams.get("key") === o.secret;
  return Effect.gen(function* () {
    yield* router.add("POST", "/mcp", (request) =>
      Effect.gen(function* () {
        if (!keyed(request)) return forbidden;
        const reply = handleMcp(o.mem, yield* request.text);
        return reply.body === null
          ? HttpServerResponse.empty({ status: reply.status })
          : HttpServerResponse.text(reply.body, { contentType: "application/json", status: reply.status });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
    // Bun answers the "mcp" subprotocol claude asks for
    yield* router.add("GET", "/mcp", (request) =>
      Effect.gen(function* () {
        if (request.headers.upgrade?.toLowerCase() !== "websocket") return HttpServerResponse.empty({ status: 405 });
        if (!keyed(request)) return forbidden;
        const socket = yield* request.upgrade;
        const write = yield* socket.writer;
        const pull = yield* Socket.readerString(socket);
        yield* pull.pipe(
          Effect.flatMap((frames) =>
            Effect.forEach(
              frames,
              (frame) => {
                const reply = handleMcp(o.mem, frame);
                return reply.body === null ? Effect.void : write.write(reply.body);
              },
              { discard: true },
            ),
          ),
          Effect.forever,
          Effect.ignore, // the socket closed
        );
        return HttpServerResponse.empty();
      }).pipe(Effect.scoped, Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
  });
};
