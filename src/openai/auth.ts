// Sign in with ChatGPT, "Use your ChatGPT plan" (SPEC "Engines", openai-plan): OAuth 2.0 with PKCE
// against auth.openai.com, a callback on 127.0.0.1, the refresh token in Secrets, access tokens in
// memory, refreshed before they expire and once on a 401. Protocol facts from OpenAI's "Sign in
// with ChatGPT" docs for open-source apps (developers.openai.com/siwc/token-sharing-open-source/sign-in
// and …/profiles-and-sessions, Oct 2026): the first sign-in sends client_id=dynamic_agent_client and
// gets its own client id back on the callback; that one is saved and used for the code exchange,
// refreshes and later sign-ins.
import { Clock, Data, Deferred, type Duration, Effect, Option, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Secrets, type SecretsError } from "../secrets.ts";
import type { Endpoints } from "./endpoints.ts";

// Nothing saved: like a spent plan, the chain moves on (the default config works before a login).
export class NotSignedIn extends Data.TaggedError("NotSignedIn")<{ readonly message: string }> {}
// The token endpoint refused the refresh token (400 invalid_grant, or 401): signed out until the
// next login, which the chain also moves past.
export class GrantRejected extends Data.TaggedError("GrantRejected")<{ readonly message: string }> {}
// The token endpoint down, unreachable, slow or answering what we can't read: reported and retried.
export class TokenEndpointError extends Data.TaggedError("TokenEndpointError")<{ readonly message: string }> {}
// Saved credentials that don't decode: reported, never taken for "not signed in".
export class BadCredentials extends Data.TaggedError("BadCredentials")<{ readonly message: string }> {}
// A sign-in that went wrong: the callback, the grant, or an ID token that isn't ours.
export class SignInError extends Data.TaggedError("SignInError")<{ readonly message: string }> {}

export type TokenError = NotSignedIn | GrantRejected | TokenEndpointError | BadCredentials | SignInError | SecretsError;

const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const authorizeUrl = (e: Endpoints) => `${e.issuer}/api/accounts/authorize`;
const tokenUrl = (e: Endpoints) => `${e.issuer}/api/accounts/oauth/token`;
const redirectUri = (e: Endpoints) => `http://127.0.0.1:${e.port}/auth/callback`;
const TOKEN_TIMEOUT = "30 seconds";

// What we keep, as one small JSON secret: only what outlives a process. Access and ID tokens
// (JWTs of a few KB each) stay in memory; a process refreshes when it first needs one. hostId is
// ext_agent_host_id, stable for this machine; subject is the ID token's `sub`, checked on refresh.
export const Credentials = Schema.Struct({
  clientId: Schema.String,
  hostId: Schema.String,
  subject: Schema.String,
  email: Schema.optional(Schema.String),
  refreshToken: Schema.String,
});
export type Credentials = typeof Credentials.Type;
export const SECRET = "openai-plan";

const CredentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson);
export const encodeCredentials = Schema.encodeSync(CredentialsJson);

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String), // rotated on every refresh; kept when absent
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optional(Schema.String),
});
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse));
const decodeOAuthError = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ error: Schema.String })));

const IdClaims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Number, // epoch seconds
  nonce: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(IdClaims));

const signInFail = (what: string) => (e: { readonly message: string }) => new SignInError({ message: `${what}: ${e.message}` });

const base64url = (b: Buffer) => b.toString("base64url");
const pkcePair = () => {
  const verifier = base64url(randomBytes(32));
  return { challenge: base64url(createHash("sha256").update(verifier).digest()), verifier };
};

const SKEW = 60_000; // clock skew allowed on `exp`, ms

// The ID token comes straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 accepts in
// place of checking its signature; issuer, audience, expiry, nonce (at sign-in) and subject (on a
// refresh: the same account) are still checked.
const checkIdToken = (
  token: string,
  o: { readonly issuer: string; readonly clientId: string; readonly nonce?: string; readonly subject?: string },
) =>
  Effect.gen(function* () {
    const payload = token.split(".")[1] ?? "";
    const claims = yield* decodeClaims(Buffer.from(payload, "base64url").toString("utf8")).pipe(Effect.mapError(signInFail("id_token")));
    const now = yield* Clock.currentTimeMillis;
    const aud = [claims.aud].flat();
    if (claims.iss.replace(/\/$/, "") !== o.issuer.replace(/\/$/, "")) return yield* new SignInError({ message: `id_token: issuer ${claims.iss}` });
    if (!aud.includes(o.clientId)) return yield* new SignInError({ message: "id_token: not issued to this client" });
    if (claims.exp * 1000 + SKEW <= now) return yield* new SignInError({ message: "id_token: expired" });
    if (o.nonce !== undefined && claims.nonce !== o.nonce) return yield* new SignInError({ message: "id_token: nonce mismatch" });
    if (o.subject !== undefined && claims.sub !== o.subject) return yield* new SignInError({ message: "id_token: a different account than the one signed in" });
    return claims;
  });

// 400 invalid_grant or a 401: the grant is gone. Anything else that isn't a 200 is the endpoint's problem.
const postForm = (e: Endpoints, form: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const res = yield* http.execute(HttpClientRequest.post(tokenUrl(e)).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyUrlParams(form)));
    const body = yield* res.text;
    if (res.status === 200) return yield* decodeTokenResponse(body).pipe(Effect.mapError((err) => new TokenEndpointError({ message: `token response: ${err.message}` })));
    const message = `token endpoint ${res.status}: ${body.slice(0, 300)}`;
    const code = Option.getOrUndefined(decodeOAuthError(body))?.error;
    if (res.status === 401 || (res.status === 400 && code === "invalid_grant")) return yield* new GrantRejected({ message });
    return yield* new TokenEndpointError({ message });
  }).pipe(
    Effect.catchTag("HttpClientError", (err) => Effect.fail(new TokenEndpointError({ message: `token endpoint: ${err.message}` }))),
    Effect.timeoutOrElse({ duration: TOKEN_TIMEOUT, orElse: () => Effect.fail(new TokenEndpointError({ message: `token endpoint: no answer within ${TOKEN_TIMEOUT}` })) }),
  );

// what is saved, if anything; a store we can't read or a secret we can't decode is an error, never "not signed in"
export const loadCredentials = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const raw = yield* secrets.get(SECRET);
  if (Option.isNone(raw)) return Option.none<Credentials>();
  const c = yield* decodeCredentials(raw.value).pipe(
    Effect.mapError(
      (err) => new BadCredentials({ message: `the saved ChatGPT sign-in (secret ${SECRET}, service optchat) does not decode; remove it and run \`optchat login openai\`: ${err.message}` }),
    ),
  );
  return Option.some(c);
});

const save = (c: Credentials) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    yield* secrets.set(SECRET, encodeCredentials(c));
  });

// The callback server, until the callback with our `state` comes. Any other request gets an error
// page and changes nothing: a local page or process can't end the sign-in by calling first.
const callbackServer = (port: number, state: string, got: Deferred.Deferred<URLSearchParams>) =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) => new SignInError({ message: `cannot listen on 127.0.0.1:${port}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      try: () =>
        Bun.serve({
          fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
            if (url.searchParams.get("state") !== state) return new Response("optchat: not the sign-in this terminal is waiting for", { status: 400 });
            Deferred.doneUnsafe(got, Effect.succeed(url.searchParams));
            return new Response("optchat: back to the terminal to see how the sign-in ended. You can close this tab.", { headers: { "content-type": "text/plain" } });
          },
          hostname: "127.0.0.1",
          port,
        }),
    }),
    (server) => Effect.promise(async () => server.stop(true)),
  );

// `optchat login openai`: the browser does the rest; `open` shows the URL (or opens it)
export const login = (o: { readonly endpoints: Endpoints; readonly open: (url: string) => Effect.Effect<void>; readonly timeout?: Duration.Input }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const e = o.endpoints;
      // a store we can't read must not pass for a first sign-in: that would register a new client and host id
      const saved = Option.getOrUndefined(yield* loadCredentials);
      const hostId = saved?.hostId ?? `urn:uuid:${randomUUID()}`;
      const { challenge, verifier } = pkcePair();
      const state = base64url(randomBytes(16)), nonce = base64url(randomBytes(16));
      const params = new URLSearchParams({
        client_id: saved?.clientId ?? e.registerClientId,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ext_agent_host_id: hostId,
        nonce,
        redirect_uri: redirectUri(e),
        resource: e.api,
        response_type: "code",
        scope: SCOPE,
        state,
      });
      if (!saved) params.set("agent_name_hint", e.agentName);

      const got = yield* Deferred.make<URLSearchParams>();
      yield* callbackServer(e.port, state, got);
      yield* o.open(`${authorizeUrl(e)}?${params.toString()}`);
      const back = yield* Deferred.await(got).pipe(
        Effect.timeoutOrElse({ duration: o.timeout ?? "5 minutes", orElse: () => Effect.fail(new SignInError({ message: "no sign-in within the time allowed" })) }),
      );

      const error = back.get("error");
      if (error !== null) return yield* new SignInError({ message: `${error}: ${back.get("error_description") ?? ""}` });
      const code = back.get("code");
      if (code === null) return yield* new SignInError({ message: "the callback has no code" });
      // a first registration names its issued client id here; dynamic_agent_client is never saved
      const clientId = back.get("client_id") ?? saved?.clientId;
      if (clientId === undefined || clientId === e.registerClientId) return yield* new SignInError({ message: "the callback has no issued client_id" });

      const t = yield* postForm(e, { client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri(e), resource: e.api }).pipe(
        Effect.catchTag("GrantRejected", (err) => Effect.fail(signInFail("code exchange")(err))),
      );
      if (t.scope !== undefined && !t.scope.split(" ").includes(PLAN_SCOPE))
        return yield* new SignInError({ message: `signed in, but plan usage (${PLAN_SCOPE}) was not granted` });
      if (t.id_token === undefined || t.refresh_token === undefined) return yield* new SignInError({ message: "the token response lacks id_token or refresh_token" });
      const claims = yield* checkIdToken(t.id_token, { clientId, issuer: e.issuer, nonce });
      const c: Credentials = { clientId, email: claims.email, hostId, refreshToken: t.refresh_token, subject: claims.sub };
      yield* save(c);
      return c;
    }),
  );

// A refresh rotates the refresh token. A returned ID token must still name the same account.
const refresh = (e: Endpoints, c: Credentials) =>
  Effect.gen(function* () {
    const t = yield* postForm(e, { client_id: c.clientId, grant_type: "refresh_token", refresh_token: c.refreshToken, resource: e.api });
    if (t.id_token !== undefined) yield* checkIdToken(t.id_token, { clientId: c.clientId, issuer: e.issuer, subject: c.subject });
    return t;
  });

const EARLY = 2 * 60_000; // refresh this long before expiry, ms

// This process's sign-in: the access token and when it expires, and the credentials it came from.
// `unsaved`: the refresh token was rotated but couldn't be saved, so memory holds the only good one.
type Session = { readonly credentials: Credentials; readonly accessToken: string; readonly expiresAt: number; readonly unsaved: boolean };

// The access token for each call. Refreshes are serialized, since every refresh rotates the
// refresh token (profiles-and-sessions: "Serialize refreshes").
export const makeTokenManager = (e: Endpoints, o: { readonly report?: (message: string) => Effect.Effect<void> } = {}) =>
  Effect.gen(function* () {
    const one = yield* Semaphore.make(1);
    const secrets = yield* Secrets;
    const http = yield* HttpClient.HttpClient;
    const report = o.report ?? ((m: string) => Effect.logError(m));
    let session: Session | null = null;

    const saved = loadCredentials.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotSignedIn({ message: "not signed in to ChatGPT: run `optchat login openai`" })),
          onSome: (c) => Effect.succeed(c),
        }),
      ),
    );

    // A failed save must not cost the session: the new refresh token stays in memory, and the
    // failure is loud, since a restart would find only the old, spent one.
    const renewFrom = (c: Credentials) =>
      Effect.gen(function* () {
        const t = yield* refresh(e, c);
        const credentials = { ...c, refreshToken: t.refresh_token ?? c.refreshToken };
        const mustSave = credentials.refreshToken !== c.refreshToken || session?.unsaved === true;
        const unsaved = mustSave
          ? yield* save(credentials).pipe(
              Effect.as(false),
              Effect.catchTag("SecretsError", (err) =>
                report(
                  `openai-plan: the rotated refresh token was not saved (${err.message}); this process keeps it in memory, but after a restart run \`optchat login openai\``,
                ).pipe(Effect.as(true)),
              ),
            )
          : false;
        const now = yield* Clock.currentTimeMillis;
        const next: Session = { accessToken: t.access_token, credentials, expiresAt: now + t.expires_in * 1000, unsaved };
        session = next;
        return next.accessToken;
      });

    // From the saved refresh token (it may have moved on in another process or a new login), unless
    // only memory has a good one. Refused, and something else is saved by now: one try with that.
    const fresh = Effect.gen(function* () {
      const c = session?.unsaved ? session.credentials : yield* saved;
      return yield* renewFrom(c).pipe(
        Effect.catchTag("GrantRejected", (err) =>
          Effect.gen(function* () {
            const now = Option.getOrUndefined(yield* loadCredentials);
            if (now === undefined || now.refreshToken === c.refreshToken) return yield* err;
            return yield* renewFrom(now);
          }),
        ),
      );
    });

    // a token valid for a while yet
    const current = one.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return session !== null && session.expiresAt - EARLY > now ? session.accessToken : yield* fresh;
      }),
    );
    // after a 401 with `stale`: refresh, unless another call already did
    const renew = (stale: string) => one.withPermit(Effect.suspend(() => (session !== null && session.accessToken !== stale ? Effect.succeed(session.accessToken) : fresh)));

    const provide = <A>(self: Effect.Effect<A, TokenError, Secrets | HttpClient.HttpClient>) =>
      self.pipe(Effect.provideService(Secrets, secrets), Effect.provideService(HttpClient.HttpClient, http));
    return { current: provide(current), renew: (stale: string) => provide(renew(stale)) };
  });
export type TokenManager = Effect.Success<ReturnType<typeof makeTokenManager>>;
