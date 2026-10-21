// @flow
// Tests of the REAL TauriBridge (not the __mocks__ one): only the Tauri IPC
// primitives (`invoke`, `convertFileSrc`) are faked, so the bridge's own
// path resolution, error mapping and argument shapes are exercised.
import TauriBridge, {
  TauriBridgeError,
  type ExportManifest,
} from './TauriBridge';

jest.mock('@tauri-apps/api/core', () => ({
  ...jest.requireActual('@tauri-apps/api/core'),
  invoke: jest.fn(),
  convertFileSrc: jest.fn(),
}));

const mockFn = (fn: Function): JestMockFn<any, any> => fn;
// Read through jest.requireMock rather than an import, so the single
// @tauri-apps/* import point lint rule (contract section 6) still holds.
const { invoke, convertFileSrc } = jest.requireMock('@tauri-apps/api/core');

describe('TauriBridge (real implementation)', () => {
  beforeEach(() => {
    mockFn(convertFileSrc).mockImplementation(
      (filePath: string) => `asset://localhost/${encodeURIComponent(filePath)}`
    );
  });

  describe('getResourceUrl / getResourceUrlSync (contract section 5)', () => {
    const cases = [
      // [projectFilePath, resourcePath, expected absolute path]
      [
        'C:\\Users\\foo\\game\\game.json',
        'images\\hero.png',
        'C:\\Users\\foo\\game\\images\\hero.png',
      ],
      [
        'C:\\Users\\foo\\game\\game.json',
        'images/hero.png',
        'C:\\Users\\foo\\game\\images/hero.png',
      ],
      [
        'C:\\Users\\foo\\game\\game.json',
        'D:\\assets\\hero.png',
        'D:\\assets\\hero.png',
      ],
      [
        'C:\\Users\\foo\\game\\game.json',
        'D:/assets/hero.png',
        'D:/assets/hero.png',
      ],
      [
        '\\\\server\\share\\game\\game.json',
        'hero.png',
        '\\\\server\\share\\game\\hero.png',
      ],
      [
        'C:\\Users\\foo\\game\\game.json',
        '\\\\server\\share\\hero.png',
        '\\\\server\\share\\hero.png',
      ],
      [
        '/home/foo/game/game.json',
        'images/hero.png',
        '/home/foo/game/images/hero.png',
      ],
      ['/home/foo/game/game.json', '/opt/hero.png', '/opt/hero.png'],
      ['/game.json', 'hero.png', '/hero.png'],
    ];

    cases.forEach(([projectFilePath, resourcePath, expectedPath]) => {
      test(`resolves "${resourcePath}" against "${projectFilePath}", sync and async alike`, async () => {
        const expectedUrl = `asset://localhost/${encodeURIComponent(
          expectedPath
        )}`;
        const syncUrl = TauriBridge.getResourceUrlSync(
          projectFilePath,
          resourcePath
        );
        const asyncUrl = await TauriBridge.getResourceUrl(
          projectFilePath,
          resourcePath
        );

        expect(syncUrl).toBe(expectedUrl);
        expect(asyncUrl).toBe(syncUrl);
        expect(invoke).not.toHaveBeenCalled();
      });
    });
  });

  describe('extname', () => {
    test('adds back the leading dot that @tauri-apps/api/path omits', async () => {
      mockFn(invoke).mockResolvedValue('json');
      await expect(TauriBridge.extname('/home/foo/game.json')).resolves.toBe(
        '.json'
      );
    });

    test("resolves '' when there is no extension", async () => {
      mockFn(invoke).mockRejectedValue('path does not have an extension');
      await expect(TauriBridge.extname('/home/foo/Makefile')).resolves.toBe('');
    });
  });

  describe('command arguments (camelCase, mapped to Rust snake_case)', () => {
    test('allowProjectDirectory', async () => {
      mockFn(invoke).mockResolvedValue(null);
      await TauriBridge.allowProjectDirectory('C:\\game');
      expect(invoke).toHaveBeenCalledWith('scope_allow_project_dir', {
        directoryPath: 'C:\\game',
      });
    });

    test('flushExport', async () => {
      const manifest: ExportManifest = {
        outputDir: '/cache/preview',
        clearOutputDir: true,
        textFiles: [],
        filesToCopy: [],
        filesToDownload: [],
      };
      const result = { written: 0, copied: 0, downloaded: 0, failures: [] };
      mockFn(invoke).mockResolvedValue(result);
      await expect(TauriBridge.flushExport(manifest)).resolves.toBe(result);
      expect(invoke).toHaveBeenCalledWith('flush_export', { manifest });
    });
  });

  describe('errors', () => {
    test('keeps the structured code of a Rust CommandError', async () => {
      mockFn(invoke).mockRejectedValue({
        code: 'WINDOW',
        message: 'failed to close preview-1: boom',
        path: null,
      });

      let error = null;
      try {
        await TauriBridge.closePreviewWindow('preview-1');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TauriBridgeError);
      expect(error && error.code).toBe('WINDOW');
      expect(error && error.message).toBe('failed to close preview-1: boom');
    });

    test('keeps the path of a Rust CommandError', async () => {
      mockFn(invoke).mockRejectedValue({
        code: 'IO',
        message: 'failed to extend fs scope: nope',
        path: 'C:\\game',
      });

      let error = null;
      try {
        await TauriBridge.allowProjectDirectory('C:\\game');
      } catch (e) {
        error = e;
      }
      expect(error && error.code).toBe('IO');
      expect(error && error.path).toBe('C:\\game');
    });

    test('infers a code from a plain plugin error string', async () => {
      mockFn(invoke).mockRejectedValue(
        'forbidden path: /etc/passwd, maybe it is not allowed on the scope'
      );

      let error = null;
      try {
        await TauriBridge.statMany(['/etc/passwd']);
      } catch (e) {
        error = e;
      }
      expect(error && error.code).toBe('OUT_OF_SCOPE');
    });
  });

  describe('init() console-forwarding safety (post-first-Windows-run fix)', () => {
    it('still resolves env even if console.log cannot be reassigned, instead of hanging forever', async () => {
      // The real suspect behind "the app got stuck on Loading... forever" on
      // the first real Windows run: attachConsoleOnce() runs BEFORE init()'s
      // own try/catch (which only wraps invoke('app_env')), so an uncaught
      // throw there - e.g. if some real WebView2 context protects console
      // methods in a way this sandbox's WebKitGTK spike and plain Node never
      // exercised - would reject init()'s promise for a reason that has
      // nothing to do with whether the app can actually start.
      //
      // Simulated via an accessor property whose setter always throws when
      // invoked, rather than a plain non-writable data property: a sloppy-
      // mode assignment to a non-writable data property silently no-ops
      // instead of throwing (only strict mode throws there, and this test
      // file's own Babel/Jest transform runs in sloppy mode, unlike the
      // real bundled app, which is always strict as ES modules) - an
      // accessor setter throws unconditionally either way, which is both
      // environment-independent and a closer match to "something throws
      // during this reassignment" in general.
      const originalLog = console.log;
      // $FlowFixMe[cannot-write] - Flow's Console lib type marks `log` read-only; deliberately redefining it for this test.
      Object.defineProperty(console, 'log', {
        get: () => originalLog,
        set: () => {
          throw new TypeError('simulated: console.log cannot be reassigned');
        },
        configurable: true,
      });

      // attachConsoleOnce() early-returns under `typeof window === 'undefined'`
      // - true here, since this whole test file runs under Jest's `node`
      // environment (not jsdom), not because of anything Tauri-specific.
      // Without a window stub this test would pass vacuously either way
      // (the console-patching code is never reached at all), which is
      // exactly what happened the first time this test was written.
      // $FlowFixMe[cannot-resolve-name] - Jest `node` env has no real window.
      global.window = { addEventListener: jest.fn() };

      try {
        mockFn(invoke).mockResolvedValueOnce({
          platform: 'windows',
          pathSeparator: '\\',
          appCacheDir: 'C:\\cache',
          documentDir: 'C:\\Documents',
          appVersion: '1.0.0',
        });

        await expect(TauriBridge.init()).resolves.toMatchObject({
          platform: 'windows',
        });
      } finally {
        // $FlowFixMe[cannot-write]
        Object.defineProperty(console, 'log', {
          value: originalLog,
          writable: true,
          configurable: true,
        });
        // $FlowFixMe[cannot-resolve-name]
        delete global.window;
      }
    });
  });
});
