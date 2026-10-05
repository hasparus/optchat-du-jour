// Sign in with ChatGPT, "Use your ChatGPT plan" (SPEC "Engines", openai-plan): OAuth 2.0 with PKCE
// against auth.openai.com, a callback on 127.0.0.1, tokens in Secrets, refreshed before they expire
// and once on a 401. Protocol facts from OpenAI's "Sign in with ChatGPT" docs for open-source apps
// (developers.openai.com/siwc/token-sharing-open-source/sign-in and …/profiles-and-sessions, Oct 2026):
// the first sign-in sends client_id=dynamic_agent_client and gets its own client id back on the
// callback; that one is saved and used for the code exchange, refreshes and later sign-ins.
import { Clock, Data, Deferred, Duration, Effect, Option, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Secrets, type SecretsError } from "../secrets.ts";

export class AuthError extends Data.TaggedError("AuthError")<{ readonly message: string }> {}

// Every endpoint is configurable (optchat.config.ts `openai`), since none of this is ours to fix.
export const Endpoints = Schema.Struct({
  issuer: Schema.String,
  api: Schema.String, // the Responses API base, also the OAuth `resource`
  registerClientId: Schema.String,
  port: Schema.Int, // the callback's; the docs allow any port, only http://127.0.0.1:{port}/auth/callback
  agentName: Schema.String, // agent_name_hint: what the user sees in ChatGPT Settings → Usage
});
export type Endpoints = typeof Endpoints.Type;

export const DEFAULT_ENDPOINTS: Endpoints = {
  agentName: "optchat-du-jour",
  api: "https://api.openai.com/v1",
  issuer: "https://auth.openai.com",
  port: 1455, // the port Codex CLI and pi use; ours only needs to be free
  registerClientId: "dynamic_agent_client",
};

const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const authorizeUrl = (e: Endpoints) => `${e.issuer}/api/accounts/authorize`;
const tokenUrl = (e: Endpoints) => `${e.issuer}/api/accounts/oauth/token`;
export const redirectUri = (e: Endpoints) => `http://127.0.0.1:${e.port}/auth/callback`;

// What we keep, as one JSON secret. hostId is ext_agent_host_id: stable for this machine.
export const Credentials = Schema.Struct({
  clientId: Schema.String,
  hostId: Schema.String,
  subject: Schema.String,
  email: Schema.optional(Schema.String),
  idToken: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number, // epoch ms
});
export type Credentials = typeof Credentials.Type;
export const SECRET = "openai-plan";

const CredentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson);
const encodeCredentials = Schema.encodeSync(CredentialsJson);

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String), // rotated on every refresh; kept when absent
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optional(Schema.String),
});
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse));

const IdClaims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  nonce: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(IdClaims));

const authFail = (what: string) => (e: { readonly message: string }) => new AuthError({ message: `${what}: ${e.message}` });
const secretFail = (e: SecretsError) => new AuthError({ message: e.message });

const base64url = (b: Buffer) => b.toString("base64url");
export const pkcePair = () => {
  const verifier = base64url(randomBytes(32));
  return { challenge: base64url(createHash("sha256").update(verifier).digest()), verifier };
};

// The ID token comes straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 accepts in
// place of checking its signature; issuer, audience and nonce are still checked.
export const checkIdToken = (token: string, o: { readonly issuer: string; readonly clientId: string; readonly nonce?: string }) =>
  Effect.gen(function* () {
    const payload = token.split(".")[1] ?? "";
    const claims = yield* decodeClaims(Buffer.from(payload, "base64url").toString("utf8")).pipe(Effect.mapError(authFail("id_token")));
    const aud = [claims.aud].flat();
    if (claims.iss.replace(/\/$/, "") !== o.issuer.replace(/\/$/, "")) return yield* new AuthError({ message: `id_token: issuer ${claims.iss}` });
    if (!aud.includes(o.clientId)) return yield* new AuthError({ message: "id_token: not issued to this client" });
    if (o.nonce !== undefined && claims.nonce !== o.nonce) return yield* new AuthError({ message: "id_token: nonce mismatch" });
    return claims;
  });

const postForm = (e: Endpoints, form: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const res = yield* http.execute(HttpClientRequest.post(tokenUrl(e)).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyUrlParams(form)));
    const body = yield* res.text;
    if (res.status !== 200) return yield* new AuthError({ message: `token endpoint ${res.status}: ${body.slice(0, 300)}` });
    return yield* decodeTokenResponse(body).pipe(Effect.mapError(authFail("token response")));
  }).pipe(Effect.catchTag("HttpClientError", (err) => Effect.fail(authFail("token endpoint")(err))));

export const loadCredentials = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const raw = yield* secrets.get(SECRET).pipe(Effect.mapError(secretFail));
  if (Option.isNone(raw)) return Option.none<Credentials>();
  return Option.some(yield* decodeCredentials(raw.value).pipe(Effect.mapError(authFail("saved credentials"))));
});

const save = (c: Credentials) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    yield* secrets.set(SECRET, encodeCredentials(c)).pipe(Effect.mapError(secretFail));
    return c;
  });

type Callback = { readonly params: URLSearchParams };

// the one-shot callback server: the first request to /auth/callback settles `got`
const callbackServer = (port: number, got: Deferred.Deferred<Callback>) =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) => new AuthError({ message: `cannot listen on 127.0.0.1:${port}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      try: () =>
        Bun.serve({
          fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
            Deferred.doneUnsafe(got, Effect.succeed({ params: url.searchParams }));
            return new Response("optchat: signed in. You can close this tab.", { headers: { "content-type": "text/plain" } });
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
      const saved = Option.getOrUndefined(yield* loadCredentials.pipe(Effect.orElseSucceed(() => Option.none<Credentials>())));
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
      if (saved) params.set("id_token_hint", saved.idToken);
      else params.set("agent_name_hint", e.agentName);

      const got = yield* Deferred.make<Callback>();
      yield* callbackServer(e.port, got);
      yield* o.open(`${authorizeUrl(e)}?${params.toString()}`);
      const { params: back } = yield* Deferred.await(got).pipe(
        Effect.timeoutOrElse({ duration: o.timeout ?? "5 minutes", orElse: () => Effect.fail(new AuthError({ message: "no sign-in within the time allowed" })) }),
      );

      if (back.get("state") !== state) return yield* new AuthError({ message: "the callback's state does not match: not our sign-in" });
      const error = back.get("error");
      if (error !== null) return yield* new AuthError({ message: `${error}: ${back.get("error_description") ?? ""}` });
      const code = back.get("code");
      if (code === null) return yield* new AuthError({ message: "the callback has no code" });
      // a first registration names its issued client id here; dynamic_agent_client is never saved
      const clientId = back.get("client_id") ?? saved?.clientId;
      if (clientId === undefined || clientId === e.registerClientId) return yield* new AuthError({ message: "the callback has no issued client_id" });

      const t = yield* postForm(e, { client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri(e), resource: e.api });
      if (t.scope !== undefined && !t.scope.split(" ").includes(PLAN_SCOPE))
        return yield* new AuthError({ message: `signed in, but plan usage (${PLAN_SCOPE}) was not granted` });
      if (t.id_token === undefined || t.refresh_token === undefined) return yield* new AuthError({ message: "the token response lacks id_token or refresh_token" });
      const claims = yield* checkIdToken(t.id_token, { clientId, issuer: e.issuer, nonce });
      const now = yield* Clock.currentTimeMillis;
      return yield* save({
        accessToken: t.access_token,
        clientId,
        email: claims.email,
        expiresAt: now + t.expires_in * 1000,
        hostId,
        idToken: t.id_token,
        refreshToken: t.refresh_token,
        subject: claims.sub,
      });
    }),
  );

// a refresh rotates the refresh token; the ID token stays when none comes back
const refresh = (e: Endpoints, c: Credentials) =>
  Effect.gen(function* () {
    const t = yield* postForm(e, { client_id: c.clientId, grant_type: "refresh_token", refresh_token: c.refreshToken, resource: e.api });
    const now = yield* Clock.currentTimeMillis;
    return yield* save({
      ...c,
      accessToken: t.access_token,
      expiresAt: now + t.expires_in * 1000,
      idToken: t.id_token ?? c.idToken,
      refreshToken: t.refresh_token ?? c.refreshToken,
    });
  });

const EARLY = Duration.toMillis(Duration.minutes(2)); // refresh this long before expiry

// The access token for each call. Refreshes are serialized, since every refresh rotates the
// refresh token (profiles-and-sessions: "Serialize refreshes").
export const makeTokens = (e: Endpoints) =>
  Effect.gen(function* () {
    const one = yield* Semaphore.make(1);
    const secrets = yield* Secrets;
    const http = yield* HttpClient.HttpClient;
    const provide = <A, E>(self: Effect.Effect<A, E, Secrets | HttpClient.HttpClient>) =>
      self.pipe(Effect.provideService(Secrets, secrets), Effect.provideService(HttpClient.HttpClient, http));

    const signedIn = loadCredentials.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AuthError({ message: "not signed in to ChatGPT: run `optchat login openai`" })),
          onSome: (c) => Effect.succeed(c),
        }),
      ),
    );

    // a token valid for a while yet
    const current = one.withPermit(
      Effect.gen(function* () {
        const c = yield* signedIn;
        const now = yield* Clock.currentTimeMillis;
        return c.expiresAt - EARLY > now ? c : yield* refresh(e, c);
      }),
    );
    // after a 401 with `stale`: refresh, unless another call already did
    const renew = (stale: string) =>
      one.withPermit(
        Effect.gen(function* () {
          const c = yield* signedIn;
          return c.accessToken === stale ? yield* refresh(e, c) : c;
        }),
      );
    return { current: provide(current), renew: (stale: string) => provide(renew(stale)) };
  });
export type Tokens = Effect.Success<ReturnType<typeof makeTokens>>;

// the defaults with whatever optchat.config.ts `openai` sets
export const endpointsOf = (o: { readonly [K in keyof Endpoints]?: Endpoints[K] | undefined } = {}): Endpoints => ({
  agentName: o.agentName ?? DEFAULT_ENDPOINTS.agentName,
  api: o.api ?? DEFAULT_ENDPOINTS.api,
  issuer: o.issuer ?? DEFAULT_ENDPOINTS.issuer,
  port: o.port ?? DEFAULT_ENDPOINTS.port,
  registerClientId: o.registerClientId ?? DEFAULT_ENDPOINTS.registerClientId,
});
