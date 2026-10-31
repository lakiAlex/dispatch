import { useCallback, useMemo, useRef, useState } from "react";
import { toAppError, type Entry } from "../api";

export interface PaneModel {
  path: string;
  entries: Entry[];
  loading: boolean;
  error: string | null;
  /** Increases on every successful load, so the table can keep or reset its selection. */
  version: number;
  canBack: boolean;
  canForward: boolean;
  navigate: (path: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  back: () => void;
  forward: () => void;
  reset: () => void;
  clearError: () => void;
}

export function usePane(lister: ((path: string) => Promise<Entry[]>) | null): PaneModel {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [historyTick, setHistoryTick] = useState(0);
  const history = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const request = useRef(0);
  const pathRef = useRef("");

  // Resolves to false only when the folder could not be opened. A load that a
  // newer one replaced resolves to true, so callers do not fall back to another folder.
  const load = useCallback(
    async (target: string): Promise<boolean> => {
      if (!lister) return false;
      const id = ++request.current;
      setLoading(true);
      try {
        const list = await lister(target);
        if (id !== request.current) return true;
        setEntries(list);
        setPath(target);
        pathRef.current = target;
        setError(null);
        setVersion((v) => v + 1);
        return true;
      } catch (e) {
        if (id !== request.current) return true;
        setError(toAppError(e).message);
        return false;
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [lister],
  );

  const navigate = useCallback(
    async (target: string) => {
      const same = target === pathRef.current;
      const ok = await load(target);
      if (ok && !same) {
        const h = history.current;
        h.stack = [...h.stack.slice(0, h.index + 1), target];
        h.index = h.stack.length - 1;
        setHistoryTick((t) => t + 1);
      }
      return ok;
    },
    [load],
  );

  const refresh = useCallback(async () => {
    if (pathRef.current) await load(pathRef.current);
  }, [load]);

  const move = useCallback(
    async (delta: number) => {
      const h = history.current;
      const index = h.index + delta;
      if (index < 0 || index >= h.stack.length) return;
      if (await load(h.stack[index])) {
        h.index = index;
        setHistoryTick((t) => t + 1);
      }
    },
    [load],
  );

  const reset = useCallback(() => {
    request.current++;
    setEntries([]);
    setPath("");
    pathRef.current = "";
    setError(null);
    setLoading(false);
    history.current = { stack: [], index: -1 };
    setHistoryTick((t) => t + 1);
  }, []);

  return useMemo(
    () => ({
      path,
      entries,
      loading,
      error,
      version,
      canBack: history.current.index > 0,
      canForward: history.current.index < history.current.stack.length - 1,
      navigate,
      refresh,
      back: () => void move(-1),
      forward: () => void move(1),
      reset,
      clearError: () => setError(null),
    }),
    // historyTick re-computes canBack/canForward after history changes.
    [path, entries, loading, error, version, historyTick, navigate, refresh, move, reset],
  );
}
