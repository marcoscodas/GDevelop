// @flow
import ResourcesLoader from '.';
import TauriBridge from '../Utils/Tauri/TauriBridge';
import { isTauri } from '../Utils/Tauri/isTauri';

// Keep optionalRequire returning null: this makes the environment neither
// Electron nor a Node.js desktop app, so only the Tauri branch can apply.
jest.mock('../Utils/OptionalRequire', () => () => null);
jest.mock('../Utils/Tauri/TauriBridge');
jest.mock('../Utils/Tauri/isTauri', () => ({ isTauri: jest.fn() }));

const mockFn = (fn: Function): JestMockFn<any, any> => fn;

const projectFile = 'C:\\Users\\foo\\game\\game.json';
const fakeNow = 1700000000000;
// What `convertFileSrc` produces on Windows for C:\Users\foo\game\images\hero.png.
const bridgeUrl =
  'http://asset.localhost/C%3A%5CUsers%5Cfoo%5Cgame%5Cimages%5Chero.png';

const makeProject = (): gdProject =>
  // $FlowFixMe[incompatible-type] - only the methods used by ResourcesLoader are faked.
  ({
    ptr: 1,
    getProjectFile: () => projectFile,
  });

describe('ResourcesLoader.getFullUrl (Tauri branch)', () => {
  let project: gdProject;

  beforeEach(() => {
    mockFn(isTauri).mockReturnValue(true);
    mockFn(TauriBridge.getResourceUrlSync).mockReturnValue(bridgeUrl);
    jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
    ResourcesLoader.burstAllUrlsCache();
    project = makeProject();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves a local resource through TauriBridge.getResourceUrlSync, with the cache-bursting parameter', () => {
    const url = ResourcesLoader.getFullUrl(project, 'images/hero.png', {});

    expect(TauriBridge.getResourceUrlSync).toHaveBeenCalledWith(
      projectFile,
      'images/hero.png'
    );
    expect(url).toBe(`${bridgeUrl}?cache=${fakeNow}`);
  });

  it('stores the resolved URL through the resources cache (cacheLocalFileUrl)', () => {
    const cacheSpy = jest.spyOn(ResourcesLoader._cache, 'cacheLocalFileUrl');

    const url = ResourcesLoader.getFullUrl(project, 'images/hero.png', {});

    expect(cacheSpy).toHaveBeenCalledWith(
      project,
      'images/hero.png',
      bridgeUrl,
      false
    );
    expect(url).toBe(`${bridgeUrl}?cache=${fakeNow}`);

    // A second lookup is served from the cache, without asking the bridge again.
    expect(ResourcesLoader.getFullUrl(project, 'images/hero.png', {})).toBe(
      url
    );
    expect(TauriBridge.getResourceUrlSync).toHaveBeenCalledTimes(1);
  });

  it('does not add the cache-bursting parameter when disableCacheBurst is set', () => {
    const url = ResourcesLoader.getFullUrl(project, 'images/hero.png', {
      disableCacheBurst: true,
    });

    expect(url).toBe(bridgeUrl);
  });

  it('leaves remote URLs to the non-Tauri path, without calling the bridge', () => {
    const url = ResourcesLoader.getFullUrl(
      project,
      'https://example.com/images/hero.png',
      { disableCacheBurst: true }
    );

    expect(TauriBridge.getResourceUrlSync).not.toHaveBeenCalled();
    expect(url).toBe('https://example.com/images/hero.png');
  });

  it('does not call the bridge when not running in Tauri', () => {
    mockFn(isTauri).mockReturnValue(false);

    ResourcesLoader.getFullUrl(project, 'images/hero.png', {
      disableCacheBurst: true,
    });

    expect(TauriBridge.getResourceUrlSync).not.toHaveBeenCalled();
  });
});
