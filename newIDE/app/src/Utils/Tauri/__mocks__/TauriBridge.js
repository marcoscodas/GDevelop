// @flow
/**
 * Jest manual mock of `Utils/Tauri/TauriBridge`.
 *
 * Implements every method of `TauriBridgeInterface` (contract v1, section 2)
 * as a `jest.fn()`, with default resolved values:
 * - `init` resolves a linux `TauriBridgeEnv`;
 * - `showOpenDialog` / `showSaveDialog` resolve `null` (a cancelled dialog is not an error);
 * - `stat` resolves `null` (the path does not exist);
 * - `getResourceUrlSync` is the only synchronous method, and returns a string.
 *
 * Usage:
 *   jest.mock('../Utils/Tauri/TauriBridge');
 *   TauriBridge.stat.mockResolvedValueOnce({ isFile: true, isDirectory: false, size: 1, mtimeMs: 0 });
 *
 * The react-scripts Jest config sets `resetMocks: true`, which wipes the
 * implementations of all `jest.fn()` before each test. The defaults are
 * therefore applied at load time and again in `beforeEach`.
 */
// $FlowFixMe[cannot-resolve-module] - Node's path module, available in Jest.
import path from 'path';
import type { TauriBridgeInterface, TauriBridgeEnv } from '../TauriBridge';

// Keyed by the TauriBridgeInterface method names (Babel cannot parse Flow
// mapped types, and $ObjMap was removed from Flow).
type MockedTauriBridge = {
  [key: $Keys<TauriBridgeInterface>]: JestMockFn<any, any>,
};

const defaultEnv: TauriBridgeEnv = {
  platform: 'linux',
  pathSeparator: '/',
  appCacheDir: '/home/test-user/.cache/gdevelop',
  documentDir: '/home/test-user/Documents',
  appVersion: '0.0.0-test',
};

const isAbsoluteNativePath = (filePath: string): boolean =>
  filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);

// Same result as `getResourceUrl`, which the contract requires for the
// sync variant. Both defaults share this helper so they cannot drift apart.
const defaultResourceUrl = (
  projectFilePath: string,
  resourcePath: string
): string => {
  const absolutePath = isAbsoluteNativePath(resourcePath)
    ? resourcePath
    : path.posix.join(path.posix.dirname(projectFilePath), resourcePath);
  return `asset://localhost/${encodeURIComponent(absolutePath)}`;
};

const TauriBridge: MockedTauriBridge = {
  init: jest.fn(),
  showOpenDialog: jest.fn(),
  showSaveDialog: jest.fn(),
  readTextFile: jest.fn(),
  readBinaryFile: jest.fn(),
  writeTextFile: jest.fn(),
  mkdir: jest.fn(),
  readDir: jest.fn(),
  remove: jest.fn(),
  copyFile: jest.fn(),
  stat: jest.fn(),
  statMany: jest.fn(),
  join: jest.fn(),
  dirname: jest.fn(),
  basename: jest.fn(),
  extname: jest.fn(),
  allowProjectDirectory: jest.fn(),
  getResourceUrl: jest.fn(),
  getResourceUrlSync: jest.fn(),
  flushExport: jest.fn(),
  startPreviewServer: jest.fn(),
  stopPreviewServer: jest.fn(),
  openPreviewWindow: jest.fn(),
  closePreviewWindow: jest.fn(),
  closeAllPreviewWindows: jest.fn(),
  onPreviewWindowClosed: jest.fn(),
  httpFetch: jest.fn(),
};

const applyDefaultImplementations = (): void => {
  TauriBridge.init.mockImplementation(async () => ({ ...defaultEnv }));

  // Cancelled dialogs resolve null, they do not reject.
  TauriBridge.showOpenDialog.mockImplementation(async () => null);
  TauriBridge.showSaveDialog.mockImplementation(async () => null);

  TauriBridge.readTextFile.mockImplementation(async () => '');
  TauriBridge.readBinaryFile.mockImplementation(async () => new Uint8Array(0));
  TauriBridge.writeTextFile.mockImplementation(async () => undefined);
  TauriBridge.mkdir.mockImplementation(async () => undefined);
  TauriBridge.readDir.mockImplementation(async () => []);
  TauriBridge.remove.mockImplementation(async () => undefined);
  TauriBridge.copyFile.mockImplementation(async () => undefined);
  TauriBridge.stat.mockImplementation(async () => null);
  TauriBridge.statMany.mockImplementation(async paths => paths.map(() => null));

  TauriBridge.join.mockImplementation(async (...segments) =>
    path.posix.join(...segments)
  );
  TauriBridge.dirname.mockImplementation(async filePath =>
    path.posix.dirname(filePath)
  );
  TauriBridge.basename.mockImplementation(async (filePath, ext) =>
    path.posix.basename(filePath, ext)
  );
  TauriBridge.extname.mockImplementation(async filePath =>
    path.posix.extname(filePath)
  );

  TauriBridge.allowProjectDirectory.mockImplementation(async () => undefined);
  TauriBridge.getResourceUrl.mockImplementation(
    async (projectFilePath, resourcePath) =>
      defaultResourceUrl(projectFilePath, resourcePath)
  );
  TauriBridge.getResourceUrlSync.mockImplementation(
    (projectFilePath, resourcePath) =>
      defaultResourceUrl(projectFilePath, resourcePath)
  );

  TauriBridge.flushExport.mockImplementation(async manifest => ({
    written: manifest.textFiles.length,
    copied: manifest.filesToCopy.length,
    downloaded: manifest.filesToDownload.length,
    failures: [],
  }));

  TauriBridge.startPreviewServer.mockImplementation(async root => ({
    origin: 'http://127.0.0.1:53817',
    port: 53817,
    root,
  }));
  TauriBridge.stopPreviewServer.mockImplementation(async () => undefined);
  TauriBridge.openPreviewWindow.mockImplementation(async () => ({
    label: 'preview-1',
  }));
  TauriBridge.closePreviewWindow.mockImplementation(async () => undefined);
  TauriBridge.closeAllPreviewWindows.mockImplementation(async () => undefined);
  TauriBridge.onPreviewWindowClosed.mockImplementation(async () => () => {});
};

applyDefaultImplementations();
if (typeof beforeEach === 'function') {
  beforeEach(applyDefaultImplementations);
}

export default TauriBridge;
