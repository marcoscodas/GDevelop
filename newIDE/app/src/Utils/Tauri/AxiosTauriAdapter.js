// @flow
// newIDE/app/src/Utils/Tauri/AxiosTauriAdapter.js
//
// A custom axios adapter that routes every request through
// `TauriBridge.httpFetch` (Rust, via `reqwest`) instead of the browser's
// XHR/fetch, so GDevelop's ~18 `Utils/GDevelopServices/*.js` files (all of
// which call axios directly, many via their own `axios.create()` instance)
// get CORS-free requests without a single one of those files changing - see
// `http_fetch.rs` for why this exists.
//
// Written against axios 0.18.1 (the version this app is pinned to)'s
// adapter contract: `(config) => Promise<response>`, called by
// `dispatchRequest` AFTER it has already resolved `config.baseURL` into an
// absolute `config.url` and flattened `config.headers` into a plain object.
// This file intentionally reuses axios's own internal `buildURL` (query
// string building) and `createError` (network-error shape) helpers rather
// than reimplementing them, so behavior matches the real XHR adapter
// exactly for anything this adapter doesn't itself change.
//
// Per the single-import-point rule (TauriBridge-contract.md section 6):
// this file does not import `@tauri-apps/*` directly, only `TauriBridge`.

import buildURL from 'axios/lib/helpers/buildURL';
import createError from 'axios/lib/core/createError';
import settle from 'axios/lib/core/settle';
import TauriBridge from './TauriBridge';

// Jest's `testEnvironment: 'node'` sandbox doesn't expose `Blob` as a global
// even on a Node version that has it (unlike a real webview, where it's
// always a global) - fall back to Node's own `buffer.Blob` so this works
// under test too, without changing behavior in the real app.
const BlobCtor: typeof Blob =
  typeof Blob !== 'undefined' ? Blob : require('buffer').Blob;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  // String.fromCharCode in chunks avoids call-stack issues on large bodies
  // (spreading a big typed array into fromCharCode's arguments can blow the
  // stack; this is the standard workaround).
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      // $FlowFixMe[incompatible-call] - subarray is a valid Uint8Array here.
      bytes.subarray(i, i + chunkSize)
    );
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * axios 0.18's `transformRequest` default already JSON.stringifies plain
 * objects and sets the Content-Type header before the adapter ever sees
 * `config.data` - so by adapter time, `data` is always a string, an
 * ArrayBuffer/ArrayBufferView, or null/undefined. FormData/Blob/Stream
 * request bodies are not used by any of the ~18 GDevelopServices callers
 * today (checked at the time this was written); such a body reaching here
 * throws a clear error instead of silently sending garbage.
 */
const encodeRequestBody = (data: mixed): string | void => {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return bytesToBase64(textEncoder.encode(data));
  if (data instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    // Flow's `mixed` refinement doesn't narrow through ArrayBuffer.isView(),
    // so cast explicitly once rather than suppressing three separate
    // property-access errors on `data.buffer`/`byteOffset`/`byteLength`.
    const view: { buffer: ArrayBuffer, byteOffset: number, byteLength: number } = (data: any);
    return bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  throw new Error(
    `AxiosTauriAdapter: unsupported request body type for ${typeof data}; ` +
      'only string and binary bodies are supported (no FormData/Blob/Stream).'
  );
};

const tauriAxiosAdapter = (config: Object): Promise<Object> => {
  const url = buildURL(config.url, config.params, config.paramsSerializer);
  const method = (config.method || 'get').toLowerCase();

  // Headers are already flattened to a plain object by axios's
  // dispatchRequest before the adapter runs; drop anything non-string
  // (axios sometimes carries a `common`/method-keyed residue on edge paths).
  const headers: { [string]: string } = {};
  Object.keys(config.headers || {}).forEach(name => {
    const value = config.headers[name];
    if (typeof value === 'string') headers[name] = value;
  });

  let bodyBase64;
  try {
    bodyBase64 = encodeRequestBody(config.data);
  } catch (e) {
    return Promise.reject(createError(e.message, config, 'ERR_BAD_REQUEST'));
  }

  return new Promise((resolve, reject) => {
    TauriBridge.httpFetch({ method, url, headers, bodyBase64 })
      .then(result => {
        const responseBytes = base64ToBytes(result.bodyBase64);

        let data;
        if (config.responseType === 'blob') {
          data = new BlobCtor([responseBytes], {
            type: result.headers['content-type'] || result.headers['Content-Type'] || '',
          });
        } else if (config.responseType === 'arraybuffer') {
          data = responseBytes.buffer;
        } else {
          // Default/'json'/'text': hand back raw text, same as the real XHR
          // adapter does - axios's own `transformResponse` (run centrally
          // by dispatchRequest) handles JSON.parse.
          data = responseBytes.length === 0 ? '' : textDecoder.decode(responseBytes);
        }

        const response = {
          data,
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          config,
          request: {},
        };

        // axios 0.18.1 (this app's pinned version) makes each ADAPTER
        // responsible for calling `settle()` - unlike later axios versions,
        // `dispatchRequest` does NOT do status-based rejection centrally.
        // Confirmed by reading lib/adapters/xhr.js, not assumed: skipping
        // this meant every response resolved regardless of status code,
        // breaking every existing `error.response.status` check.
        settle(resolve, reject, response);
      })
      .catch(cause => {
        if (cause && cause.response) {
          reject(cause); // already a well-formed rejection
          return;
        }
        reject(
          createError(
            (cause && cause.message) || 'Network Error',
            config,
            (cause && cause.code) || undefined,
            {}
          )
        );
      });
  });
};

export default tauriAxiosAdapter;
