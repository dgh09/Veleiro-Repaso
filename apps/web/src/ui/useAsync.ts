import { useCallback, useEffect, useState } from "react";

import type { ApiResult } from "../api/client";

/**
 * Every remote read is in exactly one of these states, and the UI renders the
 * one it is actually in.
 *
 * SPEC: "loading and error states that are honest. No optimistic UI that claims
 * success before the server confirms." Modelling the states as a union rather
 * than as `data | null` plus a `loading` boolean is what makes the dishonest
 * combinations unrepresentable - there is no way to hold data and call it
 * loading, or to show an error next to a stale success.
 */
export type Async<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: T };

export interface AsyncHandle<T> {
  state: Async<T>;
  reload: () => void;
  /** Replaces the value after a successful write, without a round trip. */
  set: (value: T) => void;
}

export function useAsync<T>(
  load: () => Promise<ApiResult<T>>,
  deps: readonly unknown[],
): AsyncHandle<T> {
  const [state, setState] = useState<Async<T>>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setNonce((n) => n + 1);
  }, []);

  const set = useCallback((value: T) => {
    setState({ kind: "ready", value });
  }, []);

  useEffect(() => {
    let active = true;

    void load().then((result) => {
      // The guard matters when the identity or the selected project changes
      // mid-flight: a late reply for the previous selection must not overwrite
      // the current one.
      if (!active) return;

      setState(
        result.ok
          ? { kind: "ready", value: result.value }
          : { kind: "error", message: result.message },
      );
    });

    return () => {
      active = false;
    };
    // `load` is rebuilt on every render by its caller, so the dependency list
    // is the caller's declared inputs plus the reload nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { state, reload, set };
}
