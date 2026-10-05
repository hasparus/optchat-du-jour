# optchat-du-jour

Our own [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
A fresh view every turn. [SPEC.md](./SPEC.md) is the build spec.

```sh
bun install
bun run build   # typecheck
bun run lint    # oxlint, @hasparus/oxlint-config
bun run test
```
