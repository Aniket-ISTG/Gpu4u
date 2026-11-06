"use client";

import { useCallback, useSyncExternalStore } from "react";

const KEY = "gpu4u.autoMode";
const EVENT = "gpu4u:auto-mode";

function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

const read = () => window.localStorage.getItem(KEY) === "1";

/**
 * The Auto mode switch, remembered in this browser. It only remembers a preference: it never skips the
 * wallet's signature, and it never approves a payment that needs the owner's approval.
 */
export function useAutoMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    window.localStorage.setItem(KEY, next ? "1" : "0");
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, set];
}
