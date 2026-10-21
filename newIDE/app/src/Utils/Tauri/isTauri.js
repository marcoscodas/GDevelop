// @flow
// No `@tauri-apps/*` import (contract section 6); reads a Tauri-injected
// global, safe to call from index.js on every build.
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
