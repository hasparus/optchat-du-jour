import { expect, test } from "bun:test";
import { Cover, coverHtml, coverNext } from "./draft-cover";

const at = { draft: null, latest: 1, onLatest: true, painted: true } as const;

test("a draft's picture stays over the frame until the version it became has painted", () => {
  let c = coverNext(Cover.None(), { ...at, draft: "<p>one" });
  c = coverNext(c, { ...at, draft: "<p>one</p><p>two" });
  expect(c).toEqual(Cover.Drafting({ base: 1, html: "<p>one</p><p>two" }));
  // the draft ends as its version is saved: the list still says v1, and v1 is what is painted
  c = coverNext(c, at);
  expect(coverHtml(c)).toBe("<p>one</p><p>two");
  // the list says v2, its frame not painted yet
  c = coverNext(c, { ...at, latest: 2, painted: false });
  expect(c._tag).toBe("Held");
  expect(coverNext(c, { ...at, latest: 2, painted: true })).toEqual(Cover.None());
});

test("a first version's draft is held the same way, from no version at all", () => {
  let c = coverNext(Cover.None(), { ...at, draft: "<p>new", latest: null, painted: true });
  c = coverNext(c, { ...at, latest: null, painted: true }); // nothing saved yet: "painted" is of nothing
  expect(c._tag).toBe("Held");
  expect(coverNext(c, { ...at, latest: 1, painted: true })).toEqual(Cover.None());
});

test("an older version the reader picked is never covered, and the draft covers again on the latest", () => {
  const drafting = coverNext(Cover.None(), { ...at, draft: "<p>one" });
  expect(coverNext(drafting, { ...at, draft: "<p>one", onLatest: false })).toEqual(Cover.None());
  expect(coverNext(Cover.None(), { ...at, draft: "<p>one" })._tag).toBe("Drafting");
});

test("nothing changed is the same cover", () => {
  const drafting = coverNext(Cover.None(), { ...at, draft: "<p>one" });
  expect(coverNext(drafting, { ...at, draft: "<p>one" })).toBe(drafting);
  const held = coverNext(drafting, at);
  expect(coverNext(held, at)).toBe(held);
  const none = Cover.None();
  expect(coverNext(none, at)).toBe(none);
});
