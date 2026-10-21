// @flow
// Must be index.js's first import: GDevelopServices/*.js files call
// axios.create() at module-evaluation time and bake in whatever adapter
// is set then, so this can't be a dynamic import like the rest of the
// Tauri code. Ships TauriBridge.js and @tauri-apps/* in every build as a
// result, but those are thin wrappers, negligible next to Monaco/PixiJS.

import axios from 'axios';
import { isTauri } from './isTauri';
import tauriAxiosAdapter from './AxiosTauriAdapter';

if (isTauri()) {
  axios.defaults.adapter = tauriAxiosAdapter;
}
