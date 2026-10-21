// @flow
import {
  type ResourceMover,
  type MoveAllProjectResourcesOptions,
  type MoveAllProjectResourcesResult,
  type MoveAllProjectResourcesFunction,
} from './index';
import CloudStorageProvider from '../CloudStorageProvider';
import UrlStorageProvider from '../UrlStorageProvider';
import DownloadFileStorageProvider from '../DownloadFileStorageProvider';
import { moveUrlResourcesToCloudProject } from '../CloudStorageProvider/CloudResourceMover';
import { localFileStorageProviderInternalName } from '../LocalFileStorageProvider/LocalFileStorageProviderInternalName';
import { isURL } from '../../ResourcesList/ResourceUtils';
import TauriBridge from '../../Utils/Tauri/TauriBridge';

const moveNothing = async () => {
  return {
    erroredResources: [],
  };
};

// POSIX root, Windows drive, or UNC share - no `path` module available here.
const isAbsolutePath = (filePath: string): boolean => {
  if (filePath.length === 0) return true;
  return (
    filePath.charAt(0) === '/' ||
    filePath.charAt(0) === '\\' ||
    (filePath.length > 1 && filePath.charAt(1) === ':')
  );
};

/**
 * Copies every local, relative resource file from the old project folder
 * to the new one, preserving its relative path, in one batched
 * `flushExport` call. Unlike Electron's synchronous
 * `gd.ProjectResourcesCopier`, absolute paths and URLs are left untouched
 * and per-file failures don't stop the rest.
 */
export const moveAllLocalFileResourcesToLocalFileResources = async ({
  project,
  oldFileMetadata,
  newFileMetadata,
  onProgress,
}: MoveAllProjectResourcesOptions): Promise<MoveAllProjectResourcesResult> => {
  const erroredResources = [];

  const oldProjectDir = await TauriBridge.dirname(
    oldFileMetadata.fileIdentifier
  );
  const newProjectDir = await TauriBridge.dirname(
    newFileMetadata.fileIdentifier
  );

  if (oldProjectDir === newProjectDir) {
    // Saving in the same folder (e.g: just renaming the project file):
    // resources are already at the right place, relative to the project file.
    onProgress(1, 1);
    return { erroredResources };
  }

  const resourcesManager = project.getResourcesManager();
  const allResourceNames = resourcesManager.getAllResourceNames().toJSArray();
  const resourceNamesToCopy = allResourceNames.filter(resourceName => {
    const resourceFile = resourcesManager.getResource(resourceName).getFile();
    return (
      !!resourceFile && !isURL(resourceFile) && !isAbsolutePath(resourceFile)
    );
  });

  onProgress(0, resourceNamesToCopy.length);

  const filesToCopy = await Promise.all(
    resourceNamesToCopy.map(async resourceName => {
      const resourceFile = resourcesManager.getResource(resourceName).getFile();
      const source = await TauriBridge.join(oldProjectDir, resourceFile);
      const dest = await TauriBridge.join(newProjectDir, resourceFile);
      return { resourceName, source, dest };
    })
  );

  if (filesToCopy.length) {
    const result = await TauriBridge.flushExport({
      outputDir: newProjectDir,
      clearOutputDir: false,
      textFiles: [],
      filesToCopy: filesToCopy.map(({ source, dest }) => ({ source, dest })),
      filesToDownload: [],
    });

    result.failures.forEach(({ dest, message }) => {
      const matchingFile = filesToCopy.find(
        fileToCopy => fileToCopy.dest === dest
      );
      erroredResources.push({
        resourceName: matchingFile ? matchingFile.resourceName : dest,
        error: new Error(message),
      });
    });
  }

  onProgress(resourceNamesToCopy.length, resourceNamesToCopy.length);

  return { erroredResources };
};

const movers: {
  [string]: MoveAllProjectResourcesFunction,
} = {
  // Moving to GDevelop "Cloud" storage:

  // From a Cloud project to another, resources need to be copied
  // (unless they are public URLs).
  [`${CloudStorageProvider.internalName}=>${
    CloudStorageProvider.internalName
  }`]: moveUrlResourcesToCloudProject,
  // On the web-app, most resources are public URLs, so nothing to do.
  // But if some resources are coming from a private game template,
  // they need to be copied.
  [`${UrlStorageProvider.internalName}=>${
    CloudStorageProvider.internalName
  }`]: moveUrlResourcesToCloudProject,

  // Moving to "DownloadFile":

  // Saving to "DownloadFile" will *not* change any resources, as it's a
  // "temporary save" that is made and given to the user.
  // $FlowFixMe[incompatible-type]
  [`${CloudStorageProvider.internalName}=>${
    DownloadFileStorageProvider.internalName
  }`]: moveNothing,
  // $FlowFixMe[incompatible-type]
  [`${UrlStorageProvider.internalName}=>${
    DownloadFileStorageProvider.internalName
  }`]: moveNothing,

  // Without this, save-as throws "Can't find a ResourceMover for LocalFile
  // to LocalFile".
  [`${localFileStorageProviderInternalName}=>${localFileStorageProviderInternalName}`]: moveAllLocalFileResourcesToLocalFileResources,
};

const TauriResourceMover: ResourceMover = {
  moveAllProjectResources: async (
    options: MoveAllProjectResourcesOptions
  ): Promise<MoveAllProjectResourcesResult> => {
    const { oldStorageProvider, newStorageProvider } = options;
    const mover =
      movers[
        `${oldStorageProvider.internalName}=>${newStorageProvider.internalName}`
      ];
    // $FlowFixMe[constant-condition]
    if (!mover)
      throw new Error(
        `Can't find a ResourceMover for ${oldStorageProvider.internalName} to ${
          newStorageProvider.internalName
        }.`
      );

    return mover(options);
  },
};

export default TauriResourceMover;
