// A stand-in for auth.openai.com and the Responses API, in one Bun.serve on a free port: the
// authorize page (it signs in at once and redirects, as a browser would after a click), the token
// endpoint (PKCE checked, refresh tokens rotated) and /v1/responses, which answers from a script.
import { createHash } from "node:crypto";

// what the next /v1/responses call does
export type Answer =
  | { readonly text: string; readonly cached?: number }
  | { readonly status: number; readonly code: string } // an HTTP error with an OpenAI error body
  | { readonly failed: string }; // the stream starts, then response.failed

export type Seen = { readonly token: string; readonly body: string };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
// About the size of the real ones: a few hundred bytes of claims, a 2 KB JWT all told
const PAD = "p".repeat(1200);
const jwt = (claims: Readonly<Record<string, string | number>>) => `${b64('{"alg":"RS256","kid":"fake"}')}.${b64(JSON.stringify({ ...claims, pad: PAD }))}.${"s".repeat(342)}`;
const hours = (n: number) => Math.floor(Date.now() / 1000) + n * 3600;
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
const sse = (event: { readonly type: string; readonly [key: string]: Json }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const json = (body: Json, status = 200) => Response.json(body, { status });

export type FakeState = {
  access: string; // the access token the API accepts now
  refresh: string;
  refreshes: number;
  reject: boolean; // every API call gets a 401, whatever the token
  tokenStatus: number | null; // the token endpoint answers this status and nothing else
  refreshSub: string | null; // a refresh also returns an ID token for this subject
  script: Answer[];
  readonly seen: Seen[];
  authorizeParams: URLSearchParams | null;
};

export function fakeOpenAi() {
  const issued = "oaiapp_fake";
  const state: FakeState = { access: "", authorizeParams: null, refresh: "", refreshSub: null, refreshes: 0, reject: false, script: [], seen: [], tokenStatus: null };
  let counter = 0;
  const pending = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const iss = (): string => `http://127.0.0.1:${server.port ?? 0}`;
  const fresh = () => {
    counter += 1;
    state.access = jwt({ aud: "https://api.openai.com/v1", exp: hours(1), iss: iss(), n: counter, sub: "user-1" });
    state.refresh = `rt_${counter}_${"r".repeat(500)}`;
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
        if (state.tokenStatus !== null) return new Response("upstream down", { status: state.tokenStatus });
        if (form.get("client_id") !== issued) return json({ error: "invalid_client" }, 401);
        if (form.get("grant_type") === "authorization_code") {
          const p = pending.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (!p || createHash("sha256").update(verifier).digest("base64url") !== p.challenge || form.get("redirect_uri") !== p.redirect)
            return json({ error: "invalid_grant" }, 400);
          pending.delete(form.get("code") ?? "");
          fresh();
          const idToken = jwt({ aud: issued, email: "me@example.com", exp: hours(1), iss: iss(), nonce: p.nonce, sub: "user-1" });
          return json({ access_token: state.access, expires_in: 3600, id_token: idToken, refresh_token: state.refresh, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke", token_type: "Bearer" });
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === state.refresh) {
          state.refreshes += 1;
          fresh();
          const body = { access_token: state.access, expires_in: 3600, refresh_token: state.refresh, token_type: "Bearer" };
          return json(state.refreshSub === null ? body : { ...body, id_token: jwt({ aud: issued, exp: hours(1), iss: iss(), sub: state.refreshSub }) });
        }
        return json({ error: "invalid_grant" }, 400);
      }
      if (url.pathname === "/v1/responses") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (state.reject || token !== state.access) return json({ error: { code: "invalid_token", message: "expired" } }, 401);
        const body = await req.text();
        state.seen.push({ body, token });
        const answer = state.script.shift() ?? { text: "user: ok" };
        if ("status" in answer) return json({ error: { code: answer.code, message: "limit" } }, answer.status);
        type Event = Parameters<typeof sse>[0];
        const events: Event[] =
          "failed" in answer
            ? [{ type: "response.created" }, { response: { error: { code: answer.failed, message: "stopped" } }, type: "response.failed" }]
            : [
                { type: "response.created" },
                ...[...answer.text.match(/.{1,40}/gsu) ?? []].map((delta) => ({ delta, type: "response.output_text.delta" })),
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
