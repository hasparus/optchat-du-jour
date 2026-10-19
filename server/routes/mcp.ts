// /mcp (E8): zoom and date as an MCP server, over a WebSocket (a GET that upgrades, one JSON-RPC
// message per text frame each way) or one POST per message, with spawn and tell (SPEC M7a).
// tailscale serve hides the peer, so the URL carries a secret, made at startup and sent only inside
// --mcp-config: the master's, or one subagent's own (E38), which says who calls spawn and tell.
import { Effect } from "effect";
import { type HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { forbidden } from "../../src/http.ts";
import { type AgentTools, answerMcp, type Attached, type Caller, noAgents } from "../../src/mcp.ts";
import type { Mem } from "../../src/tree.ts";

export const mcpRoutes = (
  router: HttpRouter.HttpRouter,
  o: {
    readonly mem: Mem;
    readonly secret: string;
    readonly attached: Attached;
    // the subagents' tools, and whose key is whose (SPEC "Subagents"); none: only the master's key is let in
    readonly agents?: (caller: Caller) => AgentTools;
    readonly callerOf?: (key: string) => Caller | null;
  },
) => {
  // whose key the URL carries: the master's, a subagent's, or none we know
  const callerOf = (request: HttpServerRequest.HttpServerRequest): Caller | null => {
    const key = new URL(request.url, "http://x").searchParams.get("key");
    if (key === null) return null;
    if (key === o.secret) return "master";
    return o.callerOf?.(key) ?? null;
  };
  const toolsOf = (caller: Caller) => o.agents?.(caller) ?? noAgents;
  return Effect.gen(function* () {
    yield* router.add("POST", "/mcp", (request) =>
      Effect.gen(function* () {
        const caller = callerOf(request);
        if (caller === null) return forbidden;
        const reply = yield* answerMcp(o.mem, yield* request.text, o.attached, toolsOf(caller));
        return reply.body === null
          ? HttpServerResponse.empty({ status: reply.status })
          : HttpServerResponse.text(reply.body, { contentType: "application/json", status: reply.status });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
    // Bun answers the "mcp" subprotocol claude asks for
    yield* router.add("GET", "/mcp", (request) =>
      Effect.gen(function* () {
        if (request.headers.upgrade?.toLowerCase() !== "websocket") return HttpServerResponse.empty({ status: 405 });
        const caller = callerOf(request);
        if (caller === null) return forbidden;
        const tools = toolsOf(caller);
        const socket = yield* request.upgrade;
        const write = yield* socket.writer;
        const pull = yield* Socket.readerString(socket);
        yield* pull.pipe(
          Effect.flatMap((frames) =>
            Effect.forEach(
              frames,
              (frame) =>
                answerMcp(o.mem, frame, o.attached, tools).pipe(Effect.flatMap((reply) => (reply.body === null ? Effect.void : write.write(reply.body)))),
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
