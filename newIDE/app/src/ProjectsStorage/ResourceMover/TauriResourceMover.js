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

// A resource file is considered absolute if it starts with a POSIX root
// ("/"), a Windows drive ("C:") or a UNC share ("\\server"). No node `path`
// module is available here (Wave-1 lint rule): this is a plain string check,
// mirroring `LocalFileSystem.isAbsolute`'s logic without importing it (that
// file pulls in `fs`/`os`/`path`, which Tauri code may not import either).
const isAbsolutePath = (filePath: string): boolean => {
  if (filePath.length === 0) return true;
  return (
    filePath.charAt(0) === '/' ||
    filePath.charAt(0) === '\\' ||
    (filePath.length > 1 && filePath.charAt(1) === ':')
  );
};

/**
 * Copy every local, relative resource file from the old project's folder to
 * the new project's folder, preserving its relative path, in a single
 * batched `TauriBridge.flushExport` call (contract §4, B3 consumer notes).
 *
 * Simplifications versus the Electron `LocalResourceMover`'s
 * `LocalFile=>LocalFile` entry (which uses the synchronous
 * `gd.ProjectResourcesCopier.copyAllResourcesTo` over a sync
 * `gdAbstractFileSystem`, impossible to back with TauriBridge's async-only
 * IPC):
 *  - only resources with a relative, non-URL file path are copied (the
 *    common case for a local project); absolute resource paths and URL
 *    resources are left untouched, same as they would be with
 *    `preserveAbsoluteFilenames`.
 *  - relative paths are preserved as-is (no renaming/deduplication): since
 *    the resource's `file` value does not need to change, the project is
 *    not mutated here.
 *  - per-file copy failures are reported but do not stop the others
 *    (`flushExport`'s `failures` are per-file, see contract §1).
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

  // Moving within local files: resources are copied, relative path
  // preserved, from the old project's folder to the new one (ADR-001 §2
  // correction 3, §3 B3). Without this entry, save-as throws "Can't find a
  // ResourceMover for LocalFile to LocalFile".
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
