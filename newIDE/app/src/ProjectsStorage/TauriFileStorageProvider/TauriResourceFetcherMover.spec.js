// @flow
import TauriResourceFetcher from './TauriResourceFetcher';
import TauriResourceMover from './TauriResourceMover';
import TauriBridge from '../../Utils/Tauri/TauriBridge';
const gd: libGDevelop = global.gd;

jest.mock('../../Utils/Tauri/TauriBridge');

describe('TauriResourceFetcher', () => {
  let project: gdProject;

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
  });

  test('it resolves for LocalFile projects instead of throwing "Can\'t find a ResourceFetcher"', async () => {
    await expect(
      TauriResourceFetcher.fetchAllProjectResources(
        // $FlowFixMe[incompatible-type] - only the fields read by the fetcher are provided.
        {
          project,
          fileMetadata: { fileIdentifier: 'C:\\Users\\foo\\game\\game.json' },
          storageProvider: { internalName: 'LocalFile' },
          storageProviderOperations: {},
          onProgress: jest.fn(),
        }
      )
    ).resolves.toEqual({ erroredResources: [] });
  });

  test('it still rejects storage providers that are not registered', async () => {
    await expect(
      TauriResourceFetcher.fetchAllProjectResources(
        // $FlowFixMe[incompatible-type] - only the fields read by the fetcher are provided.
        {
          project,
          fileMetadata: { fileIdentifier: 'whatever' },
          storageProvider: { internalName: 'NotAStorageProvider' },
          storageProviderOperations: {},
          onProgress: jest.fn(),
        }
      )
    ).rejects.toThrow("Can't find a ResourceFetcher for NotAStorageProvider");
  });
});

describe('TauriResourceMover', () => {
  let project: gdProject;

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
  });

  test('it resolves for LocalFile=>LocalFile instead of throwing "Can\'t find a ResourceMover"', async () => {
    await expect(
      TauriResourceMover.moveAllProjectResources(
        // $FlowFixMe[incompatible-type] - only the fields read by the mover are provided.
        {
          project,
          onProgress: jest.fn(),
          oldFileMetadata: { fileIdentifier: '/home/foo/game/game.json' },
          newFileMetadata: { fileIdentifier: '/home/foo/new/game.json' },
          oldStorageProvider: { internalName: 'LocalFile' },
          oldStorageProviderOperations: {},
          newStorageProvider: { internalName: 'LocalFile' },
          newStorageProviderOperations: {},
          authenticatedUser: undefined,
        }
      )
    ).resolves.toEqual({ erroredResources: [] });
  });

  test('it copies relative local resources into the new project folder through flushExport', async () => {
    const resource = new gd.ImageResource();
    resource.setName('Hero');
    resource.setFile('images/hero.png');
    project.getResourcesManager().addResource(resource);
    resource.delete();

    await TauriResourceMover.moveAllProjectResources(
      // $FlowFixMe[incompatible-type] - only the fields read by the mover are provided.
      {
        project,
        onProgress: jest.fn(),
        oldFileMetadata: { fileIdentifier: '/home/foo/game/game.json' },
        newFileMetadata: { fileIdentifier: '/home/foo/new/game.json' },
        oldStorageProvider: { internalName: 'LocalFile' },
        oldStorageProviderOperations: {},
        newStorageProvider: { internalName: 'LocalFile' },
        newStorageProviderOperations: {},
        authenticatedUser: undefined,
      }
    );

    // Contract section 4 (B3): the save-as resource copy goes through
    // flushExport with clearOutputDir: false and nothing to write or download.
    expect(TauriBridge.flushExport).toHaveBeenCalledTimes(1);
    expect(TauriBridge.flushExport).toHaveBeenCalledWith({
      outputDir: '/home/foo/new',
      clearOutputDir: false,
      textFiles: [],
      filesToCopy: [
        {
          source: '/home/foo/game/images/hero.png',
          dest: '/home/foo/new/images/hero.png',
        },
      ],
      filesToDownload: [],
    });
  });
});
