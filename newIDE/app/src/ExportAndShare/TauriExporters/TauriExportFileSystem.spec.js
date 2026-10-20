// @flow
import TauriExportFileSystem from './TauriExportFileSystem';

describe('TauriExportFileSystem', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('absolute paths', () => {
    test('it recognizes win32 absolute paths', () => {
      const fileSystem = new TauriExportFileSystem({ textFiles: [] });

      expect(fileSystem.isAbsolute('C:\\Users\\foo\\game\\image.png')).toBe(
        true
      );
      expect(fileSystem.isAbsolute('C:/Users/foo/game/image.png')).toBe(true);
      expect(fileSystem.isAbsolute('game\\image.png')).toBe(false);
    });

    test('it recognizes posix absolute paths', () => {
      const fileSystem = new TauriExportFileSystem({ textFiles: [] });

      expect(fileSystem.isAbsolute('/home/foo/game/image.png')).toBe(true);
      expect(fileSystem.isAbsolute('game/image.png')).toBe(false);
    });
  });

  describe('local files to copy', () => {
    test('it records a win32 local file to copy instead of rejecting it', () => {
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const fileSystem = new TauriExportFileSystem({ textFiles: [] });
      const source = 'C:\\Users\\foo\\game\\image.png';
      const dest = 'C:\\Users\\foo\\cache\\preview\\game\\image.png';

      expect(fileSystem.copyFile(source, dest)).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();

      const manifest = fileSystem.buildExportManifest({
        outputDir: 'C:\\Users\\foo\\cache\\preview',
        clearOutputDir: true,
      });
      expect(manifest.filesToCopy).toEqual([{ source, dest }]);
      expect(manifest.filesToDownload).toEqual([]);
    });

    test('it records a posix local file to copy instead of rejecting it', () => {
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const fileSystem = new TauriExportFileSystem({ textFiles: [] });
      const source = '/home/foo/game/image.png';
      const dest = '/home/foo/cache/preview/game/image.png';

      expect(fileSystem.copyFile(source, dest)).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();

      const manifest = fileSystem.buildExportManifest({
        outputDir: '/home/foo/cache/preview',
        clearOutputDir: true,
      });
      expect(manifest.filesToCopy).toEqual([{ source, dest }]);
      expect(manifest.filesToDownload).toEqual([]);
    });

    test('it still marks URLs to be downloaded rather than copied', () => {
      const fileSystem = new TauriExportFileSystem({ textFiles: [] });

      fileSystem.copyFile(
        'https://example.com/music.ogg',
        '/home/foo/cache/preview/music.ogg'
      );

      const manifest = fileSystem.buildExportManifest({
        outputDir: '/home/foo/cache/preview',
        clearOutputDir: true,
      });
      expect(manifest.filesToCopy).toEqual([]);
      expect(manifest.filesToDownload).toEqual([
        {
          url: 'https://example.com/music.ogg',
          dest: '/home/foo/cache/preview/music.ogg',
        },
      ]);
    });
  });

  describe('export manifest', () => {
    test('it builds the ExportManifest shape expected by flushExport', () => {
      const fileSystem = new TauriExportFileSystem({ textFiles: [] });
      fileSystem.writeToFile(
        '/home/foo/cache/preview/index.html',
        '<html></html>'
      );
      fileSystem.copyFile(
        '/home/foo/game/image.png',
        '/home/foo/cache/preview/images/image.png'
      );
      fileSystem.copyFile(
        'https://example.com/music.ogg',
        '/home/foo/cache/preview/music.ogg'
      );

      const manifest = fileSystem.buildExportManifest({
        outputDir: '/home/foo/cache/preview',
        clearOutputDir: true,
      });

      expect(Object.keys(manifest).sort()).toEqual([
        'clearOutputDir',
        'filesToCopy',
        'filesToDownload',
        'outputDir',
        'textFiles',
      ]);
      expect(manifest).toEqual({
        outputDir: '/home/foo/cache/preview',
        clearOutputDir: true,
        textFiles: [
          {
            dest: '/home/foo/cache/preview/index.html',
            text: '<html></html>',
          },
        ],
        filesToCopy: [
          {
            source: '/home/foo/game/image.png',
            dest: '/home/foo/cache/preview/images/image.png',
          },
        ],
        filesToDownload: [
          {
            url: 'https://example.com/music.ogg',
            dest: '/home/foo/cache/preview/music.ogg',
          },
        ],
      });
    });
  });
});
