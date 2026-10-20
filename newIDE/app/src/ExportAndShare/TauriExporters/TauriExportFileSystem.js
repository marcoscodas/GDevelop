// @flow
import { decodePercentEncodedFileName } from '../../Utils/PercentEncodedFileName';
// TauriBridge does not exist yet in this worktree (it's B1's deliverable,
// written in parallel - see ADR-001-tauri-mvp.md §3 and
// TauriBridge-contract.md). This import is correct per the contract and
// will resolve once Gate 1 merges B1. Per the Wave-1 lint rule (contract
// §6), TauriBridge.js is the only file allowed to import `@tauri-apps/*` or
// call `optionalRequire` for platform access (fs, path, electron, ...): every
// other Tauri file, including this one, goes through it instead.
import TauriBridge, {
  type ExportManifest,
  type FlushExportResult,
} from '../../Utils/Tauri/TauriBridge';

const gd: libGDevelop = global.gd;

export type TextFileDescriptor = {|
  filePath: string,
  text: string,
|};

export type UrlFileDescriptor = {|
  filePath: string,
  url: string,
|};

export type LocalFileDescriptor = {|
  filePath: string,
  source: string,
|};

type ConstructorArgs = {|
  textFiles: Array<TextFileDescriptor>,
  /**
   * The real, absolute, native directory this file system is rooted in
   * (e.g. `${env.appCacheDir}/preview`). Returned by `getTempDir` for
   * parity with BrowserFileSystem/LocalFileSystem, and used as the
   * `outputDir` of the manifest produced by `toExportManifest`/`flush`
   * when the caller doesn't override it.
   */
  rootDir: string,
|};

const isURL = (filename: string) => {
  return (
    filename.startsWith('http://') ||
    filename.startsWith('https://') ||
    filename.startsWith('ftp://') ||
    filename.startsWith('blob:') ||
    filename.startsWith('data:')
  );
};

// --- Path helpers --------------------------------------------------------
//
// BrowserFileSystem's "file system" is entirely virtual, so it can always
// treat paths as POSIX (and does, via path-browserify, which has no win32
// implementation - see its index.js). This file system is different: it's
// an in-memory staging area for a real directory on disk
// (`${env.appCacheDir}/preview`, TauriBridge-contract.md §4), and that
// directory is win32-flavored (`C:\Users\...`) on Windows, POSIX-flavored
// (`/home/...`) elsewhere. Project resources being copied in (`copyFile`'s
// `source`) can independently be either flavor, matching whatever OS the
// project was opened on. So every path here is classified by its own
// content (drive letter, UNC prefix, or a backslash), not by `env.platform`
// - this keeps the two flavors correct even when mixed in the same export,
// and keeps this file testable on any OS (see B6's win32 + posix tests).
//
// This can't reuse Node's `path` module (only TauriBridge.js may touch
// `optionalRequire('path')`, contract §6) nor `path-browserify` (posix
// only), so the minimal subset needed here is hand-rolled below.

const WIN32_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WIN32_UNC_RE = /^\\\\([^\\/]+)[\\/]([^\\/]+)[\\/]?/;

const isWindowsAbsolute = (aPath: string): boolean =>
  WIN32_DRIVE_RE.test(aPath) || WIN32_UNC_RE.test(aPath);

const isPosixAbsolute = (aPath: string): boolean => aPath.charAt(0) === '/';

const isAbsolutePath = (aPath: string): boolean =>
  isURL(aPath) || isWindowsAbsolute(aPath) || isPosixAbsolute(aPath);

// Does this specific path look win32-flavored? (drive/UNC root, or any
// backslash - a bare relative path with no separator at all is ambiguous
// and treated as POSIX, matching how BrowserFileSystem already treats every
// relative path coming from the exporter.)
const isWin32Flavored = (aPath: string): boolean =>
  isWindowsAbsolute(aPath) || aPath.indexOf('\\') !== -1;

const sepFor = (aPath: string): string => (isWin32Flavored(aPath) ? '\\' : '/');

const splitRoot = (aPath: string): {| root: string, rest: string |} => {
  const driveMatch = aPath.match(WIN32_DRIVE_RE);
  if (driveMatch) {
    return {
      root: aPath.charAt(0) + aPath.charAt(1) + '\\',
      rest: aPath.slice(driveMatch[0].length),
    };
  }
  const uncMatch = aPath.match(WIN32_UNC_RE);
  if (uncMatch) {
    return {
      root: `\\\\${uncMatch[1]}\\${uncMatch[2]}\\`,
      rest: aPath.slice(uncMatch[0].length),
    };
  }
  if (aPath.charAt(0) === '/') {
    return { root: '/', rest: aPath.slice(1) };
  }
  return { root: '', rest: aPath };
};

const normalizePath = (aPath: string): string => {
  if (isURL(aPath)) return aPath;

  const sep = sepFor(aPath);
  const { root, rest } = splitRoot(aPath);
  const segments = rest.split(/[\\/]+/).filter(segment => segment.length > 0);

  const resolvedSegments = [];
  segments.forEach(segment => {
    if (segment === '.') return;
    if (segment === '..') {
      if (
        resolvedSegments.length > 0 &&
        resolvedSegments[resolvedSegments.length - 1] !== '..'
      ) {
        resolvedSegments.pop();
      } else if (!root) {
        resolvedSegments.push('..');
      }
      // ".." above an absolute root is dropped, like Node's path.normalize.
      return;
    }
    resolvedSegments.push(segment);
  });

  const joinedSegments = resolvedSegments.join(sep);
  if (root) return root + joinedSegments;
  return joinedSegments.length > 0 ? joinedSegments : '.';
};

const resolvePath = (baseDirectory: string, aPath: string): string => {
  if (isAbsolutePath(aPath)) return normalizePath(aPath);

  const normalizedBase = isAbsolutePath(baseDirectory)
    ? baseDirectory
    : normalizePath(baseDirectory);
  const sep = sepFor(normalizedBase) || sepFor(aPath);
  const joined = normalizedBase.endsWith(sep)
    ? normalizedBase + aPath
    : normalizedBase + sep + aPath;
  return normalizePath(joined);
};

const dirnameOf = (aPath: string): string => {
  const sep = sepFor(aPath);
  const { root, rest } = splitRoot(normalizePath(aPath));
  const segments = rest.split(/[\\/]+/).filter(segment => segment.length > 0);
  segments.pop();
  if (segments.length === 0) return root ? root : '.';
  return root + segments.join(sep);
};

const basenameOf = (aPath: string, ext?: string): string => {
  const segments = aPath.split(/[\\/]+/).filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : '';
  if (ext && last.length > ext.length && last.slice(-ext.length) === ext) {
    return last.slice(0, -ext.length);
  }
  return last;
};

const relativePath = (fromDirectory: string, toPath: string): string => {
  const sep = sepFor(fromDirectory) || sepFor(toPath);
  const fromSegments = splitRoot(normalizePath(fromDirectory))
    .rest.split(/[\\/]+/)
    .filter(Boolean);
  const toSegments = splitRoot(normalizePath(toPath))
    .rest.split(/[\\/]+/)
    .filter(Boolean);

  let commonLength = 0;
  while (
    commonLength < fromSegments.length &&
    commonLength < toSegments.length &&
    fromSegments[commonLength] === toSegments[commonLength]
  ) {
    commonLength++;
  }

  const upSegments = fromSegments.length - commonLength;
  const downSegments = toSegments.slice(commonLength);
  const parts = [];
  for (let i = 0; i < upSegments; i++) parts.push('..');
  const result = parts.concat(downSegments).join(sep);
  return result.length > 0 ? result : '.';
};

/**
 * An in-memory "file system" used to stage a GDevelop export (preview or
 * otherwise) before it's flushed to real disk by Rust through
 * `TauriBridge.flushExport`. Adapted from BrowserFileSystem, which this
 * can't reuse as-is (ADR-001-tauri-mvp.md §2.5): its `copyFile` rejects
 * local absolute-path sources, and its path helpers are POSIX-only so a
 * `C:\...` source is never recognized as absolute. Here, `copyFile` always
 * records a local source (never rejects it) so it reaches the export
 * manifest's `filesToCopy`, and path handling works for both win32 and
 * POSIX absolute paths.
 */
export default class TauriExportFileSystem {
  _rootDir: string;

  /** Text files to write (dest => content). @private */
  _textFiles: { [string]: string } = {};

  /** Local absolute-path files to copy on disk (dest => source). @private */
  _filesToCopy: { [string]: string } = {};

  /** Files to download from a URL (dest => url). @private */
  _filesToDownload: { [string]: string } = {};

  constructor({ textFiles, rootDir }: ConstructorArgs) {
    this._rootDir = rootDir;
    textFiles.forEach(textFileDescriptor => {
      this._textFiles[normalizePath(textFileDescriptor.filePath)] =
        textFileDescriptor.text;
    });
  }

  /** Returns all the in-memory text files with the specified path prefix. */
  getAllTextFilesIn = (pathPrefix: string): Array<TextFileDescriptor> => {
    return Object.keys(this._textFiles)
      .filter(filePath => filePath.indexOf(pathPrefix) === 0)
      .map(filePath => ({ filePath, text: this._textFiles[filePath] }));
  };

  /** Returns all the files to be downloaded from a URL, with the specified destination path prefix. */
  getAllUrlFilesIn = (pathPrefix: string): Array<UrlFileDescriptor> => {
    return Object.keys(this._filesToDownload)
      .filter(filePath => filePath.indexOf(pathPrefix) === 0)
      .map(filePath => ({ filePath, url: this._filesToDownload[filePath] }));
  };

  /** Returns all the local files to be copied on disk, with the specified destination path prefix. */
  getAllLocalFilesIn = (pathPrefix: string): Array<LocalFileDescriptor> => {
    return Object.keys(this._filesToCopy)
      .filter(filePath => filePath.indexOf(pathPrefix) === 0)
      .map(filePath => ({ filePath, source: this._filesToCopy[filePath] }));
  };

  mkDir = (path: string): any => {
    // "Directories" are assumed to exist - they're created by Rust (mkdir,
    // including every missing parent) when the manifest is flushed.
    return true;
  };
  dirExists = (path: string): any => {
    return true;
  };
  clearDir = (path: string): any => {
    const prefix = normalizePath(path);
    [this._textFiles, this._filesToCopy, this._filesToDownload].forEach(
      store => {
        Object.keys(store).forEach(filePath => {
          if (filePath.indexOf(prefix) === 0) delete store[filePath];
        });
      }
    );
    return true;
  };
  getTempDir = (): any => {
    return this._rootDir;
  };
  fileNameFrom = (fullpath: string): any => {
    if (isURL(fullpath)) {
      return decodePercentEncodedFileName(basenameOf(fullpath));
    }
    return basenameOf(fullpath);
  };
  dirNameFrom = (fullpath: string): any => {
    if (isURL(fullpath)) return fullpath;
    return dirnameOf(fullpath);
  };
  makeAbsolute = (filePathOrURL: string, baseDirectoryOrURL: string): any => {
    if (isURL(filePathOrURL)) return filePathOrURL;
    if (isURL(baseDirectoryOrURL))
      return baseDirectoryOrURL + '/' + filePathOrURL;

    return resolvePath(baseDirectoryOrURL, filePathOrURL);
  };
  makeRelative = (filePathOrURL: string, baseDirectoryOrURL: string): any => {
    if (isURL(filePathOrURL)) {
      if (filePathOrURL.indexOf(baseDirectoryOrURL) === 0) {
        return filePathOrURL.substring(baseDirectoryOrURL.length);
      }
      console.warn(
        `${filePathOrURL} cannot be made relative to ${baseDirectoryOrURL}, please double check this behavior is correct.`
      );
      return filePathOrURL;
    }

    return relativePath(baseDirectoryOrURL, filePathOrURL);
  };
  isAbsolute = (fullpath: string): any => {
    return isAbsolutePath(fullpath);
  };

  copyFile = (source: string, dest: string): any => {
    const normalizedDest = normalizePath(dest);

    // URLs are not copied, but marked as to be downloaded.
    if (isURL(source)) {
      if (isURL(dest)) {
        console.error(
          `Destination can't be a URL in copyFile (from ${source} to ${dest}).`
        );
        return false;
      }
      this._filesToDownload[normalizedDest] = source;
      return true;
    }

    // Already in memory as a text file (e.g. generated code, project data)?
    if (this._textFiles.hasOwnProperty(source)) {
      this._textFiles[normalizedDest] = this._textFiles[source];
      return true;
    }

    // Already scheduled to be downloaded, under this exact path?
    if (this._filesToDownload.hasOwnProperty(source)) {
      this._filesToDownload[normalizedDest] = this._filesToDownload[source];
      return true;
    }

    // Already scheduled to be copied from disk, under this exact path?
    if (this._filesToCopy.hasOwnProperty(source)) {
      this._filesToCopy[normalizedDest] = this._filesToCopy[source];
      return true;
    }

    // Otherwise, this is a local absolute path on disk (a project resource,
    // GDJS runtime file, or generated events-function code): record it to
    // be copied by Rust at flush time. Unlike BrowserFileSystem, this is
    // NOT an error - this is exactly the case BrowserFileSystem drops
    // silently (ADR-001-tauri-mvp.md §2.5).
    this._filesToCopy[normalizedDest] = source;
    return true;
  };

  writeToFile = (filePath: string, content: string): any => {
    this._textFiles[normalizePath(filePath)] = content;
    return true;
  };

  readFile = (file: string): string => {
    if (this._textFiles[file]) return this._textFiles[file];

    console.error(`Unknown file ${file}, returning an empty string`);
    return '';
  };

  readDir = (path: string, ext: string): any => {
    const upperCaseExt = ext.toUpperCase();
    const output = new gd.VectorString();

    // Simulate ReadDir by returning the on-disk (not purely in-memory)
    // files matching the extension: those scheduled for download, and
    // those scheduled to be copied from local disk.
    [this._filesToDownload, this._filesToCopy].forEach(store => {
      Object.keys(store).forEach(filePath => {
        const upperCaseFilePath = filePath.toUpperCase();
        if (
          upperCaseFilePath.indexOf(upperCaseExt) ===
          upperCaseFilePath.length - upperCaseExt.length
        ) {
          output.push_back(filePath);
        }
      });
    });

    return output;
  };

  fileExists = (filePath: string): any => {
    if (isURL(filePath)) return true;

    const normalizedFilePath = normalizePath(filePath);
    return (
      !!this._textFiles[normalizedFilePath] ||
      !!this._filesToDownload[normalizedFilePath] ||
      !!this._filesToCopy[normalizedFilePath]
    );
  };

  /**
   * Build the `ExportManifest` (TauriBridge-contract.md §1) describing
   * everything staged in this file system so far.
   */
  toExportManifest = ({
    outputDir,
    clearOutputDir,
  }: {|
    outputDir: string,
    clearOutputDir: boolean,
  |}): ExportManifest => {
    return {
      outputDir,
      clearOutputDir,
      textFiles: Object.keys(this._textFiles).map(dest => ({
        dest,
        text: this._textFiles[dest],
      })),
      filesToCopy: Object.keys(this._filesToCopy).map(dest => ({
        source: this._filesToCopy[dest],
        dest,
      })),
      filesToDownload: Object.keys(this._filesToDownload).map(dest => ({
        url: this._filesToDownload[dest],
        dest,
      })),
    };
  };

  /**
   * Build the export manifest and flush it to real disk through
   * `TauriBridge.flushExport`.
   */
  flush = ({
    outputDir,
    clearOutputDir,
  }: {|
    outputDir: string,
    clearOutputDir: boolean,
  |}): Promise<FlushExportResult> => {
    return TauriBridge.flushExport(
      this.toExportManifest({ outputDir, clearOutputDir })
    );
  };
}
