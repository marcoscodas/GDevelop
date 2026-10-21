// @flow
// Custom axios adapter routing requests through TauriBridge.httpFetch
// (see http_fetch.rs), so GDevelopServices/*.js callers get CORS-free
// requests with no per-file changes. Only file besides TauriBridge.js
// allowed near the SDK boundary - reuses axios's own buildURL/createError
// so untouched behavior matches the real XHR adapter.

import buildURL from 'axios/lib/helpers/buildURL';
import createError from 'axios/lib/core/createError';
import settle from 'axios/lib/core/settle';
import TauriBridge from './TauriBridge';

// Jest's node environment has no global Blob.
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

// No caller sends FormData/Blob/Stream; such a body throws here instead
// of silently sending garbage.
const encodeRequestBody = (data: mixed): string | void => {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return bytesToBase64(textEncoder.encode(data));
  if (data instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
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

  // dispatchRequest already flattened headers; drop any non-string residue.
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
          // dispatchRequest's transformResponse handles JSON.parse.
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

        // axios 0.18.1 adapters call settle() themselves for status-based
        // rejection; dispatchRequest doesn't do it centrally.
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
