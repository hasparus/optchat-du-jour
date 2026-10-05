# optchat-du-jour

Our own [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
A fresh view every turn. [SPEC.md](./SPEC.md) is the build spec.

```sh
bun install
bun run build   # typecheck, and the web UI into web/dist
bun run lint    # oxlint, @hasparus/oxlint-config
bun run test    # also the web UI's tests (web/, happy-dom)
cd web && bun run e2e   # Playwright: the real server, a fake claude, Chromium at 360 px
cd web && bun run dev   # Vite, proxying /ws and /api to a server on 127.0.0.1:7700
```
