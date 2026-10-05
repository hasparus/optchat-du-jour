// One /api read for a screen: its data, or why it failed, and a way to read it again.
import { useCallback, useEffect, useState } from "react";

export type Loaded<A> = { readonly data: A | null; readonly error: string | null; readonly reload: () => void };

export function useApi<A>(read: () => Promise<A>): Loaded<A> {
  const [data, setData] = useState<A | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const value = await read();
        if (!live) return;
        setData(value);
        setError(null);
      } catch (error_) {
        if (live) setError(error_ instanceof Error ? error_.message : String(error_));
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [read, round]);
  const reload = useCallback(() => {
    setRound((r) => r + 1);
  }, []);
  return { data, error, reload };
}
