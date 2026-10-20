// @flow
/**
 * Detect whether the app is running inside a Tauri webview.
 *
 * This must stay free of any `@tauri-apps/*` import (see TauriBridge-contract.md
 * section 6 - the single import point lint rule). It only ever reads a global
 * injected by the Tauri runtime, so it's safe to call from `index.js` on every
 * build (web, Electron and Tauri) with no side effects.
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
