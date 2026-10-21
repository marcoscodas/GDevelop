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

  describe('init() console-forwarding safety', () => {
    it('still resolves env even if console.log cannot be reassigned, instead of hanging forever', async () => {
      // attachConsoleOnce() runs before init()'s own try/catch, so an
      // uncaught throw there must not reject init() for an unrelated
      // reason. An accessor setter throws unconditionally in both strict
      // and sloppy mode, unlike a plain non-writable data property.
      const originalLog = console.log;
      // $FlowFixMe[cannot-write]
      Object.defineProperty(console, 'log', {
        get: () => originalLog,
        set: () => {
          throw new TypeError('simulated: console.log cannot be reassigned');
        },
        configurable: true,
      });

      // Jest's node env has no window; attachConsoleOnce() needs one to proceed.
      // $FlowFixMe[cannot-resolve-name]
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
