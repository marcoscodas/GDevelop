// @flow
// newIDE/app/src/Utils/Tauri/TauriBridge.js — contract v1 implementation.
//
// This is the ONLY file in the Tauri codebase allowed to import `@tauri-apps/*`
// or call `optionalRequire` on `electron`/`fs`/`path`/`os` (see
// TauriBridge-contract.md section 6, the single-import-point lint rule). Every
// other Tauri file (TauriApp.js, ProjectsStorage/Tauri*, ExportAndShare/TauriExporters,
// the rest of Utils/Tauri, and Tauri code writers/fetchers/movers) must go
// through this module instead of importing the SDK or Node-ish globals directly.
//
// The contract (frozen for Wave 1, see TauriBridge-contract.md) is implemented
// exactly: every method here is async and returns a Promise, with exactly one
// documented exception, `getResourceUrlSync` (contract section 5).

import {
  open as pluginShowOpenDialog,
  save as pluginShowSaveDialog,
} from '@tauri-apps/plugin-dialog';
import {
  readTextFile as pluginReadTextFile,
  readFile as pluginReadBinaryFile,
  writeTextFile as pluginWriteTextFile,
  mkdir as pluginMkdir,
  readDir as pluginReadDir,
  remove as pluginRemove,
  copyFile as pluginCopyFile,
  stat as pluginStat,
} from '@tauri-apps/plugin-fs';
import {
  join as pathJoin,
  dirname as pathDirname,
  basename as pathBasename,
  extname as pathExtname,
} from '@tauri-apps/api/path';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  error as pluginLogError,
  warn as pluginLogWarn,
  info as pluginLogInfo,
  debug as pluginLogDebug,
} from '@tauri-apps/plugin-log';

// MVP diagnostics: forwards `console.*` calls (libGD.js init messages,
// resource/SW failures...), plus uncaught errors and unhandled promise
// rejections, into the Rust-side log sink (see tauri-app/src-tauri/src/
// main.rs's tauri_plugin_log registration), so a tester's log file is a
// complete record without needing devtools open.
//
// NOTE, corrected after the first real Windows run (2026-10-20): this
// package's `attachConsole()`/`attachLogger()` do the OPPOSITE of what the
// name suggests - they forward Rust-side logs INTO the webview console (for
// when devtools is open), not the webview's console out to Rust. The actual
// JS-to-Rust direction is the plain `error`/`warn`/`info`/`debug` functions
// imported above, each a thin `invoke('plugin:log|log', ...)`. The first
// build shipped with the former, which produced an almost-empty log file
// (just tao/wry's own internal debug lines) - this monkey-patch is the fix.
//
// `init()` is awaited exactly once by TauriApp.js before first render, which
// makes it the natural, single place to start this - not a reason to treat
// it as part of the frozen contract's public surface (it isn't listed in
// TauriBridgeInterface and callers must not rely on its return value).
let consoleAttached = false;
const toLogMessage = (args: Array<mixed>): string =>
  args
    .map(arg => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return String(arg);
      }
    })
    .join(' ');

const attachConsoleOnce = (): void => {
  if (consoleAttached) return;
  consoleAttached = true;

  if (typeof window === 'undefined' || typeof console === 'undefined') return;

  const original = {
    log: console.log,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => {
    original.log(...args);
    pluginLogDebug(toLogMessage(args)).catch(() => {});
  };
  console.debug = (...args) => {
    original.debug(...args);
    pluginLogDebug(toLogMessage(args)).catch(() => {});
  };
  console.info = (...args) => {
    original.info(...args);
    pluginLogInfo(toLogMessage(args)).catch(() => {});
  };
  console.warn = (...args) => {
    original.warn(...args);
    pluginLogWarn(toLogMessage(args)).catch(() => {});
  };
  console.error = (...args) => {
    original.error(...args);
    pluginLogError(toLogMessage(args)).catch(() => {});
  };

  window.addEventListener('error', event => {
    pluginLogError(
      `Uncaught error: ${event.message} (${event.filename}:${event.lineno}:${
        event.colno
      })`
    ).catch(() => {});
  });
  window.addEventListener('unhandledrejection', event => {
    pluginLogError(`Unhandled promise rejection: ${String(event.reason)}`).catch(
      () => {}
    );
  });

  pluginLogInfo('[TauriBridge] console + error forwarding attached').catch(
    () => {}
  );
};

// --- 1. Types (contract v1, section 1) -------------------------------------

export type TauriPlatform = 'windows' | 'macos' | 'linux';

/** Resolved once by init(); plain data, safe to pass into factories and sync code. */
export type TauriBridgeEnv = {|
  platform: TauriPlatform,
  pathSeparator: '\\' | '/',
  /** App-private cache dir; preview exports and generated events code live under it. */
  appCacheDir: string,
  /** User's Documents dir; default parent for new local projects. */
  documentDir: string,
  /** Tauri app version (tauri.conf.json), for logs/telemetry only. */
  appVersion: string,
|};

export type TauriBridgeErrorCode =
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED' // OS-level denial
  | 'OUT_OF_SCOPE' // Tauri fs/asset scope denial: call allowProjectDirectory first
  | 'ALREADY_EXISTS'
  | 'IO'
  | 'PORT_UNAVAILABLE'
  | 'WINDOW'
  | 'UNKNOWN';

/** The only error type the bridge rejects with. Plugin/command error strings are mapped to `code`. */
export class TauriBridgeError extends Error {
  code: TauriBridgeErrorCode;
  path: ?string;
  cause: mixed;

  constructor(
    code: TauriBridgeErrorCode,
    message: string,
    options?: {| path?: ?string, cause?: mixed |}
  ) {
    super(message);
    this.name = 'TauriBridgeError';
    this.code = code;
    this.path = (options && options.path) || null;
    this.cause = options ? options.cause : undefined;
  }
}

export type FileFilter = {| name: string, extensions: Array<string> |}; // extensions without dot

export type OpenDialogOptions = {|
  title?: string,
  defaultPath?: string,
  filters?: Array<FileFilter>,
  multiple?: boolean,
  /** Pick a folder instead of a file (save-as location chooser, new project). */
  directory?: boolean,
|};

export type SaveDialogOptions = {|
  title?: string,
  defaultPath?: string,
  filters?: Array<FileFilter>,
|};

export type FileStat = {|
  isFile: boolean,
  isDirectory: boolean,
  size: number,
  /** Last modification time, ms since epoch (0 if the OS doesn't report it). */
  mtimeMs: number,
|};

export type DirEntry = {|
  name: string,
  isFile: boolean,
  isDirectory: boolean,
|};

/** Produced by TauriExportFileSystem (B4) or TauriResourceMover (B3); consumed by flush_export (B2). */
export type ExportManifest = {|
  /** Absolute. Every `dest` below must be inside it; Rust rejects others with OUT_OF_SCOPE. */
  outputDir: string,
  /** Delete outputDir contents first (preview: true; resource copy on save-as: false). */
  clearOutputDir: boolean,
  textFiles: Array<{| dest: string, text: string |}>,
  /** Local absolute source → absolute dest (resources, generated events code, GDJS files on disk). */
  filesToCopy: Array<{| source: string, dest: string |}>,
  /** http(s) source → absolute dest, downloaded by Rust with bounded concurrency. */
  filesToDownload: Array<{| url: string, dest: string |}>,
|};

export type FlushExportResult = {|
  written: number,
  copied: number,
  downloaded: number,
  /** Per-file failures do NOT reject (a missing resource must not kill a preview). */
  failures: Array<{|
    dest: string,
    code: TauriBridgeErrorCode,
    message: string,
  |}>,
|};

export type PreviewServer = {|
  /** e.g. "http://127.0.0.1:53817" — always loopback, never 0.0.0.0 in Wave 1. */
  origin: string,
  port: number,
  root: string,
|};

export type PreviewWindowOptions = {|
  /** Must start with the running PreviewServer's origin; Rust rejects anything else. */
  url: string,
  title: string,
  width: number,
  height: number,
  alwaysOnTop: boolean,
|};

export type PreviewWindowHandle = {| label: string |};

export type Unlisten = () => void;

// --- v1.1 addition (post-MVP, see http_fetch.rs for the why) ---------------
export type HttpFetchRequest = {|
  method: string,
  url: string,
  headers: { [string]: string },
  /** Base64-encoded request body, or undefined for bodyless requests. */
  bodyBase64?: string,
|};

export type HttpFetchResponse = {|
  status: number,
  statusText: string,
  headers: { [string]: string },
  /** Base64-encoded response body; caller decides text vs. JSON vs. Blob. */
  bodyBase64: string,
|};

export type TauriBridgeInterface = {|
  // --- lifecycle ---------------------------------------------------------
  /** Fetch platform + well-known dirs once; TauriApp awaits this before create(). Idempotent. */
  init(): Promise<TauriBridgeEnv>,

  // --- dialogs (plugin-dialog) ------------------------------------------
  /** Native open dialog; null if cancelled; always an array (length 1 unless `multiple`). */
  showOpenDialog(options: OpenDialogOptions): Promise<Array<string> | null>,
  /** Native save dialog; null if cancelled. Does not create the file. */
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>,

  // --- files (plugin-fs) -------------------------------------------------
  /** Read a UTF-8 text file (game.json, split-object JSON, autosave). */
  readTextFile(path: string): Promise<string>,
  /** Read raw bytes (later waves: resource import/upload). */
  readBinaryFile(path: string): Promise<Uint8Array>,
  /** Write a UTF-8 file, creating missing parent directories (mirrors fs-extra ensureDir+writeFile). */
  writeTextFile(path: string, content: string): Promise<void>,
  /** Create a directory recursively; no-op if it exists. */
  mkdir(path: string): Promise<void>,
  /** List direct children of a directory (non-recursive). */
  readDir(path: string): Promise<Array<DirEntry>>,
  /** Remove a file, or a directory recursively. NOT_FOUND is swallowed (resolves). */
  remove(path: string): Promise<void>,
  /** Copy one file, overwriting dest, creating dest's parent dirs. */
  copyFile(source: string, dest: string): Promise<void>,
  /** Stat a path; resolves null if it does not exist (replaces existsSync + statSync pairs). */
  stat(path: string): Promise<FileStat | null>,
  /** Batched stat, same order as input; null entries for missing paths. One IPC call. */
  statMany(paths: Array<string>): Promise<Array<FileStat | null>>,

  // --- paths (@tauri-apps/api/path) --------------------------------------
  /** Join and normalize segments with the platform separator. */
  join(...segments: Array<string>): Promise<string>,
  /** Parent directory of a path. */
  dirname(path: string): Promise<string>,
  /** Last path segment; strips `ext` if given and matching (e.g. '.json'). */
  basename(path: string, ext?: string): Promise<string>,
  /** Extension including the dot, or '' if none. */
  extname(path: string): Promise<string>,

  // --- scope + resource URLs --------------------------------------------
  /** Grant fs + asset-protocol access to a project folder, recursively. Call on EVERY project open/save-as. */
  allowProjectDirectory(directoryPath: string): Promise<void>,
  /** URL a webview can load for a project resource (absolute or relative to the project file's dir). */
  getResourceUrl(
    projectFilePath: string,
    resourcePath: string
  ): Promise<string>,
  /** SYNC EXCEPTION — same result as getResourceUrl; only for ResourcesLoader.getFullUrl (see §5). */
  getResourceUrlSync(projectFilePath: string, resourcePath: string): string,

  // --- export flush (custom command) -------------------------------------
  /** Write text files, copy local files and download URLs in one IPC call. */
  flushExport(manifest: ExportManifest): Promise<FlushExportResult>,

  // --- preview (custom commands + event) ---------------------------------
  /** Start (or re-point) the loopback static server on `root`; idempotent; serves index.html at "/". */
  startPreviewServer(root: string): Promise<PreviewServer>,
  /** Stop the server if running; no-op otherwise. */
  stopPreviewServer(): Promise<void>,
  /** Open a top-level preview window on a preview-server URL; window has no IPC capabilities. */
  openPreviewWindow(
    options: PreviewWindowOptions
  ): Promise<PreviewWindowHandle>,
  /** Close one preview window; resolves if already closed. */
  closePreviewWindow(label: string): Promise<void>,
  /** Close every preview window (editor close, new preview with "replace" semantics). */
  closeAllPreviewWindows(): Promise<void>,
  /** Subscribe to preview-window closes (user or programmatic); resolves to an unsubscribe fn. */
  onPreviewWindowClosed(callback: (label: string) => void): Promise<Unlisten>,

  // --- generic HTTPS proxy (custom command, v1.1) ------------------------
  /**
   * Performs an HTTPS request from Rust, bypassing the webview's CORS
   * entirely (Rust's HTTP client has no concept of it). Added after the
   * MVP's first real Windows run showed GDevelop's own backends (asset
   * store, tutorials, the GDJS runtime fetch preview depends on) failing
   * together - the likely cause being this app's origin
   * (`https://tauri.localhost`) not being covered by their CORS allowlist.
   * Not used directly by application code: installed once as a custom
   * axios adapter (`Utils/Tauri/AxiosTauriAdapter.js`), so the ~18 existing
   * `GDevelopServices/*.js` files that already call axios get this for
   * free. HTTPS only; non-HTTPS URLs reject with OUT_OF_SCOPE.
   */
  httpFetch(request: HttpFetchRequest): Promise<HttpFetchResponse>,
|};

// --- 2. Error mapping --------------------------------------------------------
//
// plugin-fs/plugin-dialog/custom commands reject with a string (or an object
// with a `message` string) rather than a typed error. We do our best to infer
// a TauriBridgeErrorCode from that message so callers can branch on `code`
// (e.g. OUT_OF_SCOPE -> call allowProjectDirectory and retry) without having
// to string-match themselves.

const errorMessageOf = (cause: mixed): string => {
  if (typeof cause === 'string') return cause;
  if (
    cause &&
    typeof cause === 'object' &&
    // $FlowFixMe[incompatible-use]
    typeof cause.message === 'string'
  ) {
    // $FlowFixMe[incompatible-use]
    return cause.message;
  }
  try {
    return JSON.stringify(cause) || String(cause);
  } catch (e) {
    return String(cause);
  }
};

const inferErrorCode = (message: string): TauriBridgeErrorCode => {
  const lowerCaseMessage = message.toLowerCase();
  if (
    lowerCaseMessage.includes('not found') ||
    lowerCaseMessage.includes('no such file') ||
    lowerCaseMessage.includes('os error 2')
  )
    return 'NOT_FOUND';
  if (
    lowerCaseMessage.includes('permission denied') ||
    lowerCaseMessage.includes('os error 13')
  )
    return 'PERMISSION_DENIED';
  if (
    lowerCaseMessage.includes('forbidden path') ||
    lowerCaseMessage.includes('out of scope') ||
    lowerCaseMessage.includes('not allowed') ||
    lowerCaseMessage.includes('scope')
  )
    return 'OUT_OF_SCOPE';
  if (
    lowerCaseMessage.includes('already exists') ||
    lowerCaseMessage.includes('os error 17')
  )
    return 'ALREADY_EXISTS';
  if (
    lowerCaseMessage.includes('address already in use') ||
    lowerCaseMessage.includes('port')
  )
    return 'PORT_UNAVAILABLE';
  if (lowerCaseMessage.includes('window')) return 'WINDOW';
  if (lowerCaseMessage.includes('io error') || lowerCaseMessage.includes('i/o'))
    return 'IO';
  return 'UNKNOWN';
};

const KNOWN_ERROR_CODES: Array<TauriBridgeErrorCode> = [
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'OUT_OF_SCOPE',
  'ALREADY_EXISTS',
  'IO',
  'PORT_UNAVAILABLE',
  'WINDOW',
  'UNKNOWN',
];

// The custom Rust commands (B2, error.rs) reject with a structured
// `{ code, message, path }` object whose `code` is already a contract
// error code: trust it rather than re-inferring one from the message.
const structuredErrorCodeOf = (cause: mixed): ?TauriBridgeErrorCode => {
  if (!cause || typeof cause !== 'object') return null;
  // $FlowFixMe[incompatible-use]
  const code = cause.code;
  return KNOWN_ERROR_CODES.find(knownCode => knownCode === code) || null;
};

const structuredErrorPathOf = (cause: mixed): ?string => {
  if (!cause || typeof cause !== 'object') return null;
  // $FlowFixMe[incompatible-use]
  return typeof cause.path === 'string' ? cause.path : null;
};

const toBridgeError = (cause: mixed, path?: ?string): TauriBridgeError => {
  if (cause instanceof TauriBridgeError) return cause;
  const message = errorMessageOf(cause);
  return new TauriBridgeError(
    structuredErrorCodeOf(cause) || inferErrorCode(message),
    message,
    {
      path: structuredErrorPathOf(cause) || path,
      cause,
    }
  );
};

// --- 3. Pure path helpers for getResourceUrl/getResourceUrlSync ------------
//
// Contract section 5: the resolution of a (possibly relative) resource path
// against the project file's directory must be pure JS, must never call IPC,
// and must give the exact same result for getResourceUrl and
// getResourceUrlSync. It recognizes `X:\`, `X:/` and `\\server\share` as
// absolute on Windows, and `/` elsewhere.

const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]|^\\\\/;

const isAbsoluteResourcePath = (resourcePath: string): boolean =>
  WINDOWS_ABSOLUTE_PATH_RE.test(resourcePath) || resourcePath.startsWith('/');

const lastSeparatorIndex = (path: string): number =>
  Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

/** Resolve a resource path (absolute or relative to the project file) to an absolute, native path. */
const resolveResourceAbsolutePath = (
  projectFilePath: string,
  resourcePath: string
): string => {
  if (isAbsoluteResourcePath(resourcePath)) return resourcePath;

  const separatorIndex = lastSeparatorIndex(projectFilePath);
  if (separatorIndex < 0) return resourcePath;

  const projectDirectory = projectFilePath.slice(0, separatorIndex);
  const separator = projectFilePath[separatorIndex];
  if (!projectDirectory) return `${separator}${resourcePath}`;

  return `${projectDirectory}${separator}${resourcePath}`;
};

// --- 4. The bridge -----------------------------------------------------------

const TauriBridge: TauriBridgeInterface = {
  init: async (): Promise<TauriBridgeEnv> => {
    attachConsoleOnce();
    try {
      return await invoke('app_env');
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  showOpenDialog: async (
    options: OpenDialogOptions
  ): Promise<Array<string> | null> => {
    try {
      const result = await pluginShowOpenDialog({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        multiple: !!options.multiple,
        directory: !!options.directory,
      });
      if (result === null || result === undefined) return null;
      return Array.isArray(result) ? result : [result];
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  showSaveDialog: async (
    options: SaveDialogOptions
  ): Promise<string | null> => {
    try {
      const result = await pluginShowSaveDialog({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result === undefined ? null : result;
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  readTextFile: async (path: string): Promise<string> => {
    try {
      return await pluginReadTextFile(path);
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  readBinaryFile: async (path: string): Promise<Uint8Array> => {
    try {
      return await pluginReadBinaryFile(path);
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  writeTextFile: async (path: string, content: string): Promise<void> => {
    try {
      const separatorIndex = lastSeparatorIndex(path);
      if (separatorIndex > 0) {
        await pluginMkdir(path.slice(0, separatorIndex), {
          recursive: true,
        });
      }
      await pluginWriteTextFile(path, content);
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  mkdir: async (path: string): Promise<void> => {
    try {
      await pluginMkdir(path, { recursive: true });
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  readDir: async (path: string): Promise<Array<DirEntry>> => {
    try {
      const entries = await pluginReadDir(path);
      return entries.map(entry => ({
        name: entry.name || '',
        isFile: !!entry.isFile,
        isDirectory: !!entry.isDirectory,
      }));
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  remove: async (path: string): Promise<void> => {
    try {
      await pluginRemove(path, { recursive: true });
    } catch (cause) {
      const bridgeError = toBridgeError(cause, path);
      if (bridgeError.code === 'NOT_FOUND') return;
      throw bridgeError;
    }
  },

  copyFile: async (source: string, dest: string): Promise<void> => {
    try {
      const separatorIndex = lastSeparatorIndex(dest);
      if (separatorIndex > 0) {
        await pluginMkdir(dest.slice(0, separatorIndex), {
          recursive: true,
        });
      }
      await pluginCopyFile(source, dest);
    } catch (cause) {
      throw toBridgeError(cause, dest);
    }
  },

  stat: async (path: string): Promise<FileStat | null> => {
    try {
      const info = await pluginStat(path);
      return {
        isFile: !!info.isFile,
        isDirectory: !!info.isDirectory,
        size: info.size || 0,
        mtimeMs: info.mtime ? new Date(info.mtime).getTime() : 0,
      };
    } catch (cause) {
      const bridgeError = toBridgeError(cause, path);
      if (bridgeError.code === 'NOT_FOUND') return null;
      throw bridgeError;
    }
  },

  statMany: async (paths: Array<string>): Promise<Array<FileStat | null>> => {
    try {
      return await invoke('fs_stat_many', { paths });
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  join: async (...segments: Array<string>): Promise<string> => {
    try {
      return await pathJoin(...segments);
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  dirname: async (path: string): Promise<string> => {
    try {
      return await pathDirname(path);
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  basename: async (path: string, ext?: string): Promise<string> => {
    try {
      return await pathBasename(path, ext);
    } catch (cause) {
      throw toBridgeError(cause, path);
    }
  },

  extname: async (path: string): Promise<string> => {
    try {
      // @tauri-apps/api/path's extname returns the extension WITHOUT the
      // leading dot (unlike Node's path.extname). The contract specifies
      // "including the dot, or '' if none", so we add it back here.
      const extensionWithoutDot = await pathExtname(path);
      return extensionWithoutDot ? `.${extensionWithoutDot}` : '';
    } catch (cause) {
      // extname() rejects (instead of resolving '') when the path has no
      // extension at all on some Tauri versions; treat that as ''.
      const bridgeError = toBridgeError(cause, path);
      if (bridgeError.code === 'NOT_FOUND' || bridgeError.code === 'UNKNOWN')
        return '';
      throw bridgeError;
    }
  },

  allowProjectDirectory: async (directoryPath: string): Promise<void> => {
    try {
      await invoke('scope_allow_project_dir', { directoryPath });
    } catch (cause) {
      throw toBridgeError(cause, directoryPath);
    }
  },

  getResourceUrl: async (
    projectFilePath: string,
    resourcePath: string
  ): Promise<string> => {
    try {
      return convertFileSrc(
        resolveResourceAbsolutePath(projectFilePath, resourcePath)
      );
    } catch (cause) {
      throw toBridgeError(cause, resourcePath);
    }
  },

  // SYNC EXCEPTION (contract §5): convertFileSrc is pure string building over
  // window.__TAURI_INTERNALS__, and the path resolution above never calls IPC,
  // so this can stay synchronous without any extra cost. Must return the same
  // result as getResourceUrl for the same inputs (checked by B6).
  getResourceUrlSync: (projectFilePath: string, resourcePath: string): string =>
    convertFileSrc(resolveResourceAbsolutePath(projectFilePath, resourcePath)),

  flushExport: async (manifest: ExportManifest): Promise<FlushExportResult> => {
    try {
      return await invoke('flush_export', { manifest });
    } catch (cause) {
      throw toBridgeError(cause, manifest.outputDir);
    }
  },

  startPreviewServer: async (root: string): Promise<PreviewServer> => {
    try {
      return await invoke('preview_server_start', { root });
    } catch (cause) {
      throw toBridgeError(cause, root);
    }
  },

  stopPreviewServer: async (): Promise<void> => {
    try {
      await invoke('preview_server_stop');
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  openPreviewWindow: async (
    options: PreviewWindowOptions
  ): Promise<PreviewWindowHandle> => {
    try {
      return await invoke('preview_window_open', { options });
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  closePreviewWindow: async (label: string): Promise<void> => {
    try {
      await invoke('preview_window_close', { label });
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  closeAllPreviewWindows: async (): Promise<void> => {
    try {
      await invoke('preview_window_close_all');
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  onPreviewWindowClosed: async (
    callback: (label: string) => void
  ): Promise<Unlisten> => {
    try {
      const unlisten = await listen('preview-window-closed', event => {
        // $FlowFixMe[incompatible-call] - payload is the label string (see contract §3).
        callback(event.payload);
      });
      return unlisten;
    } catch (cause) {
      throw toBridgeError(cause);
    }
  },

  httpFetch: async (request: HttpFetchRequest): Promise<HttpFetchResponse> => {
    try {
      return await invoke('http_fetch', { request });
    } catch (cause) {
      throw toBridgeError(cause, request.url);
    }
  },
};

export default TauriBridge;
