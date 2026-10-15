# Read-only library references

`effect/` is a squashed Git subtree of https://github.com/Effect-TS/effect.git,
release `effect@4.0.4`, commit `e17ecdbe902aa7108f775c8ab9c0ddf9f38801ab`.
The machine-readable pin is [effect-reference.json](effect-reference.json). It matches
root/web `effect` and `@effect/platform-bun` 4.0.4. The upstream tree, MIT LICENSE and
LLMS.md are unchanged. No submodule initialization or install inside the subtree is needed.

This follows the [Effect source-vendoring guide](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive),
but pins a release instead of tracking main. Read [effect/LLMS.md](effect/LLMS.md) first,
then its ai-docs, implementations and tests. Import normal npm packages, never this tree.
It is not an application workspace, build input, test suite or runtime dependency.

## Authorized updates

Only update the reference when explicitly requested and after aligning runtime dependencies.
Resolve the new release tag against the official repository and record its peeled commit:

```sh
git ls-remote https://github.com/Effect-TS/effect.git 'refs/tags/effect@<version>*'
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git <verified-commit> --squash
```

Update the pin above and in effect-reference.json, review LLMS.md and the linked pattern notes,
then run the gates in root AGENTS.md. Preserve all upstream files. Do not use subtree push,
edit upstream code locally, or import it into the app.

To verify the imported tree against a fetched upstream commit:

```sh
git rev-parse HEAD:repos/effect
git rev-parse e17ecdbe902aa7108f775c8ab9c0ddf9f38801ab^{tree}
git log --format=full --grep='git-subtree-split:'
```

The two tree IDs must match; the recorded upstream tree is
`d721789c47a6c55f6f43d6be0517e0dd4af90620`. Bun, oxlint, TypeScript and editor exclusions deliberately keep
this reference out of application scanning; it remains tracked and readable by agents.
