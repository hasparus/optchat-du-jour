// A stand-in for auth.openai.com and the Responses API, in one Bun.serve on a free port: the
// authorize page (it signs in at once and redirects, as a browser would after a click), the token
// endpoint (PKCE checked, refresh tokens rotated) and /v1/responses, which answers from a script:
// streamed text, function calls, an HTTP error or a failed stream. An answer may wait on `gate`
// before it starts, so a test can act while a request is in flight.
import { createHash } from "node:crypto";

// what the next /v1/responses call does
export type Call = { readonly name: string; readonly arguments: string };
export type Answer =
  | { readonly text?: string; readonly calls?: readonly Call[]; readonly cached?: number; readonly gate?: Promise<unknown> }
  | { readonly status: number; readonly code: string } // an HTTP error with an OpenAI error body
  | { readonly failed: string }; // the stream starts, then response.failed

export type Seen = { readonly token: string; readonly body: string };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (claims: Readonly<Record<string, string>>) => `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.sig`;
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
const sse = (event: { readonly type: string; readonly [key: string]: Json }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const json = (body: Json, status = 200) => Response.json(body, { status });

export type FakeState = {
  access: string; // the access token the API accepts now
  refresh: string;
  refreshes: number;
  reject: boolean; // every API call gets a 401, whatever the token
  script: Answer[];
  readonly seen: Seen[];
  authorizeParams: URLSearchParams | null;
};

export function fakeOpenAi() {
  const issued = "oaiapp_fake";
  const state: FakeState = { access: "", authorizeParams: null, refresh: "", refreshes: 0, reject: false, script: [], seen: [] };
  let counter = 0;
  const pending = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const fresh = () => {
    counter += 1;
    state.access = `access-${counter}`;
    state.refresh = `refresh-${counter}`;
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/accounts/authorize") {
        const p = url.searchParams;
        state.authorizeParams = p;
        const code = `code-${pending.size}`;
        pending.set(code, { challenge: p.get("code_challenge") ?? "", nonce: p.get("nonce") ?? "", redirect: p.get("redirect_uri") ?? "" });
        const back = new URL(p.get("redirect_uri") ?? "");
        back.search = new URLSearchParams({ client_id: issued, code, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke", state: p.get("state") ?? "" }).toString();
        return Response.redirect(back.toString(), 302);
      }
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("client_id") !== issued) return json({ error: "invalid_client" }, 401);
        if (form.get("grant_type") === "authorization_code") {
          const p = pending.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (!p || createHash("sha256").update(verifier).digest("base64url") !== p.challenge || form.get("redirect_uri") !== p.redirect)
            return json({ error: "invalid_grant" }, 400);
          pending.delete(form.get("code") ?? "");
          fresh();
          const idToken = jwt({ aud: issued, email: "me@example.com", iss: `http://127.0.0.1:${server.port ?? 0}`, nonce: p.nonce, sub: "user-1" });
          return json({ access_token: state.access, expires_in: 3600, id_token: idToken, refresh_token: state.refresh, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke", token_type: "Bearer" });
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === state.refresh) {
          state.refreshes += 1;
          fresh();
          return json({ access_token: state.access, expires_in: 3600, refresh_token: state.refresh, token_type: "Bearer" });
        }
        return json({ error: "invalid_grant" }, 400);
      }
      if (url.pathname === "/v1/responses") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (state.reject || token !== state.access) return json({ error: { code: "invalid_token", message: "expired" } }, 401);
        const body = await req.text();
        state.seen.push({ body, token });
        const answer = state.script.shift() ?? { text: "user: ok" };
        if ("gate" in answer) await answer.gate;
        if ("status" in answer) return json({ error: { code: answer.code, message: "limit" } }, answer.status);
        type Event = Parameters<typeof sse>[0];
        const events: Event[] =
          "failed" in answer
            ? [{ type: "response.created" }, { response: { error: { code: answer.failed, message: "stopped" } }, type: "response.failed" }]
            : [
                { type: "response.created" },
                ...[...(answer.text ?? "").match(/.{1,40}/gsu) ?? []].map((delta) => ({ delta, type: "response.output_text.delta" })),
                ...(answer.text ? [{ item: { content: [{ text: answer.text, type: "output_text" }], type: "message" }, type: "response.output_item.done" }] : []),
                ...(answer.calls ?? []).map((c, k) => ({
                  item: { arguments: c.arguments, call_id: `call_${state.seen.length}_${k}`, name: c.name, type: "function_call" },
                  type: "response.output_item.done",
                })),
                {
                  response: { model: "fake-luna", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: answer.cached ?? 0 }, output_tokens: 50 } },
                  type: "response.completed",
                },
              ];
        return new Response(events.map(sse).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port ?? 0}`;
  return { base, issued, server, state };
}
