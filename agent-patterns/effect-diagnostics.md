# Native Effect diagnostics policy

`bun run lint:effect` runs the pinned `@effect/tsgo` 0.52.0 executable over root and web
projects with `diagnostics --strict --severity error,warning`. CI's `--format github-actions`
is forwarded to both invocations. Missing binaries, spawn exceptions, signals and nonzero exits
fail the gate. No compiler or oxlint binary is patched.

The **installed 0.52.0 package**, not upstream main, documents TypeScript 7.0.2 support in
`node_modules/@effect/tsgo/README.md`. Its `schema.json` supports `allowedUnstableApis` as an
array of package/module paths or `package/module#export` identifiers. The native companion is
`@typescript/native: npm:typescript@7.0.2`. Root/web build and root postinstall explicitly invoke
`node_modules/typescript/bin/tsc` with Bun (web uses `../node_modules/...`), preserving TS5.9.3
and standalone vendor scripts. Bare `tsc` resolves to TS7 in the verified install and is ambiguous;
use the package scripts instead. The compiler version can be checked explicitly:

```sh
mise exec bun@1.4.2 -- bun node_modules/typescript/bin/tsc --version
```

## Deliberately accepted unstable exports

Historical baseline native scans checked 139 root and 59 web files with Effect V4 support,
no missing plugin files, and no errors. Baseline final coverage was 140 root / 59 web files
after adding the tooling tests.
A baseline repeat scan with `--lspconfig '{}'` (permissions removed) reproduced exactly the
then-configured 38/2 export sets, proving no unused permission entries at that baseline.
All 135 root / 2 web warnings at that baseline were
`unstableApiUsage` (TS377136). These
existing platform integrations implement filesystem/process/device IO, HTTP serving and
provider transport, SSE and sockets. Rewriting runtime behavior is not part of this tooling change.

The root plugin's current **41 exact export identifiers** below include the reviewed
`effect/encoding/Sse#Retry` addition. The pinned `Sse.ts` defines this decoder-produced retry
directive as a typed class. Its exact `instanceof` guard normalizes SSE reconnect directives
without swallowing generic callback errors that merely share the `Retry` tag. They also include
`effect/http/HttpClient#make` and `effect/http/HttpClientResponse#fromWeb`, reviewed for the cache
replay's fake vendors only (test/fake-vendors.ts): an HttpClient that answers in this process, on
the replay's test clock, so the real api-key and openai-plan clients run unchanged with no socket
between them and the fake, whose round trip the clock could not see. This source-guided
addition does not change the historical scan counts above. The web
plugin accepts only `@effect/platform-bun/BunRuntime#runMain` and `effect/http/FetchHttpClient#layer`
for its fake-provider e2e server. There are no wildcard/module permissions, experimental API
permissions, per-file ignores, or severity overrides. New APIs require a deliberate policy review.

```text
@effect/platform-bun/BunHttpServer#layer
@effect/platform-bun/BunRuntime#runMain
@effect/platform-bun/BunServices#layer
effect/FileSystem#FileSystem
effect/PlatformError#PlatformError
effect/encoding/Sse#Retry
effect/encoding/Sse#SseError
effect/encoding/Sse#decode
effect/http/FetchHttpClient#layer
effect/http/HttpClient#HttpClient
effect/http/HttpClient#make
effect/http/HttpClientError#isHttpClientError
effect/http/HttpClientRequest#HttpClientRequest
effect/http/HttpClientRequest#accept
effect/http/HttpClientRequest#acceptJson
effect/http/HttpClientRequest#bearerToken
effect/http/HttpClientRequest#bodyText
effect/http/HttpClientRequest#bodyUrlParams
effect/http/HttpClientRequest#get
effect/http/HttpClientRequest#post
effect/http/HttpClientRequest#setHeaders
effect/http/HttpClientResponse#fromWeb
effect/http/HttpRouter#HttpRouter
effect/http/HttpRouter#params
effect/http/HttpRouter#serve
effect/http/HttpRouter#use
effect/http/HttpServerRequest#HttpServerRequest
effect/http/HttpServerRequest#schemaSearchParams
effect/http/HttpServerResponse#empty
effect/http/HttpServerResponse#file
effect/http/HttpServerResponse#jsonUnsafe
effect/http/HttpServerResponse#schemaJson
effect/http/HttpServerResponse#text
effect/process/ChildProcess#make
effect/process/ChildProcessSpawner#ChildProcessSpawner
effect/socket/Socket#CloseEvent
effect/socket/Socket#Socket
effect/socket/Socket#SocketError
effect/socket/Socket#layerWebSocketConstructorGlobal
effect/socket/Socket#makeWebSocket
effect/socket/Socket#readerString
```

[test/effect-tooling.test.ts](../test/effect-tooling.test.ts) exercises the real native binary
using temporary, isolated configs inheriting each project's policy. Floating Effect fails with
TS377001; the unaccepted `effect/http/HttpClientRequest#put` fails with TS377136, even in the same
module as accepted exports; accepted `BunRuntime#runMain` passes. Fixtures are linted, never run,
and always removed. The tests also verify runner failures, arguments, schema support and exclusions.

For coverage evidence, run `bun run lint:effect -- --format json --list-files`; files report
`detectedEffect: "v4"` and `supportedEffect: "v4"`. Suggestions remain upstream defaults and
are outside the canonical error/warning gate. Diagnostics do not replace manual lifecycle,
cancellation, retry/idempotency or type-boundary audits.

## Editors

The legacy JS editor plugin remains pinned at `@effect/language-service` 0.87.4. VS Code's TS
SDK points to the JS compiler. No editor extension has been installed by this change. If choosing
a native editor LSP, configure **effect-tsgo instead of official tsgo**, never both simultaneously;
see the installed package's “Relationship to Official TypeScript-Go” instructions. The dedicated
CLI gate is authoritative regardless of editor choice. `repos/**` is excluded from search,
watching, file display and auto-imports, but stays tracked for source-guided agents.
