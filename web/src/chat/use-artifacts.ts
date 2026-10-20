// The artifacts' list for the chat's cards and the pane (SPEC "Artifacts"): read from
// /api/artifacts once connected, and again whenever a version is saved (Session.saved). A server
// from before artifacts answers 404, and an offline one nothing: the list stays as it was.
import { api } from "@/lib/api";
import type { ArtifactInfo } from "@wire";
import { useEffect, useState, useSyncExternalStore } from "react";

const NONE: readonly ArtifactInfo[] = [];

export function useArtifactList(saved: number, connected: boolean): readonly ArtifactInfo[] {
  const [list, setList] = useState(NONE);
  useEffect(() => {
    if (!connected) return;
    let current = true;
    api.artifacts().then(
      (read) => {
        if (current) setList(read);
      },
      () => {
        // none to show
      },
    );
    return () => {
      current = false;
    };
  }, [saved, connected]);
  return list;
}

// a screen wide enough for the pane beside the chat (DESIGN.md, Artifacts: from 1024 px)
const WIDE = "(min-width: 1024px)";
const wide = () => "matchMedia" in globalThis && matchMedia(WIDE).matches;
const nothing = () => {
  // no media queries here (a test's DOM): nothing to stop listening to
};
const onWidth = (changed: () => void) => {
  if (!("matchMedia" in globalThis)) return nothing;
  const query = matchMedia(WIDE);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};
export const useWide = () => useSyncExternalStore(onWidth, wide);
