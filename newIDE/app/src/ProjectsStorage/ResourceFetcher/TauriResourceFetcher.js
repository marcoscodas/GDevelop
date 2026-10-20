// @flow
import {
  type ResourceFetcher,
  type FetchAllProjectResourcesOptions,
  type FetchAllProjectResourcesResult,
  type FetchAllProjectResourcesFunction,
} from './index';
import CloudStorageProvider from '../CloudStorageProvider';
import { moveUrlResourcesToCloudFilesIfPrivate } from '../CloudStorageProvider/CloudResourceFetcher';
import UrlStorageProvider from '../UrlStorageProvider';
import { fetchRelativeResourcesToFullUrls } from '../UrlStorageProvider/UrlResourceFetcher';
import { localFileStorageProviderInternalName } from '../LocalFileStorageProvider/LocalFileStorageProviderInternalName';

// Resources of a local project are already on disk next to the project
// file: there is nothing to download after opening it (ADR-001 §1, "out of
// MVP": downloading URL resources to disk after opening a project stays a
// no-op; URL resources stay URLs and need network).
const fetchNothing = async (): Promise<FetchAllProjectResourcesResult> => ({
  erroredResources: [],
});

const fetchers: {
  [string]: FetchAllProjectResourcesFunction,
} = {
  // The Cloud file storage provider fetches the resources that are
  // private URLs by downloading them and reuploading them to the cloud.
  // $FlowFixMe[incompatible-type]
  [CloudStorageProvider.internalName]: moveUrlResourcesToCloudFilesIfPrivate,
  // The URL storage consider relative resources to be relative to the project
  // URL. This allows to open local projects uploaded to GitHub for example.
  // $FlowFixMe[incompatible-type]
  [UrlStorageProvider.internalName]: fetchRelativeResourcesToFullUrls,
  // Without this entry, BrowserResourceFetcher's equivalent map would throw
  // "Can't find a ResourceFetcher for LocalFile" on every single local
  // project open (ADR-001 §2 correction 3, §3 B3).
  [localFileStorageProviderInternalName]: fetchNothing,
};

const TauriResourceFetcher: ResourceFetcher = {
  fetchAllProjectResources: async (
    options: FetchAllProjectResourcesOptions
  ): Promise<FetchAllProjectResourcesResult> => {
    const { storageProvider } = options;
    const fetcher = fetchers[storageProvider.internalName];
    // $FlowFixMe[constant-condition]
    if (!fetcher)
      throw new Error(
        `Can't find a ResourceFetcher for ${
          storageProvider.internalName
        } - have you registered the storage provider here?`
      );

    return fetcher(options);
  },
};

export default TauriResourceFetcher;
