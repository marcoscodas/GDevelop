// @flow
// newIDE/app/src/Utils/Tauri/InstallAxiosAdapter.js
//
// Must be the FIRST thing imported, bundle-wide (see index.js) - before
// `Authentication.js` or any other `Utils/GDevelopServices/*.js` file, most
// of which call `axios.create()` at module-evaluation time and bake in
// whatever `axios.defaults.adapter` is set at that exact moment. Importing
// this any later would silently miss every module already evaluated by then
// (Authentication.js in particular is index.js's own 5th import line).
//
// No-ops entirely outside Tauri (isTauri() false) at RUNTIME, but being
// forced to run synchronously (see above) means this is a static, not
// dynamic, import - so TauriBridge.js and the @tauri-apps/* packages it
// imports now ship in the Electron and Browser bundles too, not just
// Tauri's, unlike the rest of the Tauri code (reached only via TauriApp.js,
// which those builds never dynamically import). Accepted deliberately for
// now: these are thin JS wrappers, a negligible addition next to Monaco/
// PixiJS/etc., and every Tauri-import-chain file already has Jest coverage
// confirming it's inert outside a real Tauri webview (TauriBridge.spec.js
// and friends import it directly under plain Jest/jsdom and pass). Revisit
// if bundle size analysis ever says otherwise - not before.

import axios from 'axios';
import { isTauri } from './isTauri';
import tauriAxiosAdapter from './AxiosTauriAdapter';

if (isTauri()) {
  axios.defaults.adapter = tauriAxiosAdapter;
}
