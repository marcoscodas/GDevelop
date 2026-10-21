// @flow
import { t, Trans } from '@lingui/macro';
import * as React from 'react';
import {
  serializeToJSObject,
  serializeToJSON,
  addFinalNewline,
} from '../../Utils/Serializer';
import { serializeToJSObjectInBackground } from '../../Utils/BackgroundSerializer';
import {
  type FileMetadata,
  type SaveAsLocation,
  type SaveAsOptions,
  type SaveProjectOptions,
} from '../index';
import {
  split,
  splitPaths,
  getSlugifiedUniqueNameFromProperty,
} from '../../Utils/ObjectSplitter';
import type { MessageDescriptor } from '../../Utils/i18n/MessageDescriptor.flow';
import SaveAsOptionsDialog from '../SaveAsOptionsDialog';
import {
  type ShowAlertFunction,
  type ShowConfirmFunction,
} from '../../UI/Alert/AlertContext';
import TauriBridge from '../../Utils/Tauri/TauriBridge';
import TauriFolderPicker from './TauriFolderPicker';

/**
 * Tauri equivalent of LocalProjectWriter.js, using TauriBridge instead of
 * `fs-extra`/`electron.remote.dialog`. See TauriBridge-contract.md §4 (B3).
 */

export const splittedProjectFolderNames = [
  'layouts',
  'externalLayouts',
  'externalEvents',
  'eventsFunctionsExtensions',
];

// Minimal, dependency-free path helpers, used ONLY to compute *suggested*
// file names/locations synchronously for the UI (`getProjectLocation`,
// `renderNewProjectSaveAsLocationChooser`). They never touch disk. Every
// actual filesystem path resolution in this file goes through
// `TauriBridge.join`/`dirname` (async) instead.
//
// This is necessary because the `StorageProvider.getProjectLocation` contract
// is synchronous, while TauriBridge's path helpers are all async (there is no
// sync path-join exposed, unlike the one documented exception
// `getResourceUrlSync`). These helpers detect the separator from the input
// path itself instead of depending on `TauriBridgeEnv.pathSeparator` (which
// is only available once `TauriBridge.init()` has resolved).
const detectSeparator = (aPath: string): string =>
  aPath.indexOf('\\') !== -1 && aPath.indexOf('/') === -1 ? '\\' : '/';

const dirnameSync = (aPath: string): string => {
  const sep = detectSeparator(aPath);
  const index = aPath.lastIndexOf(sep);
  if (index === -1) return '';
  if (index === 0) return sep;
  return aPath.substring(0, index);
};

const basenameSync = (aPath: string): string => {
  const sep = detectSeparator(aPath);
  const index = aPath.lastIndexOf(sep);
  return index === -1 ? aPath : aPath.substring(index + 1);
};

const joinSync = (...segments: Array<string>): string => {
  const nonEmptySegments = segments.filter(segment => !!segment);
  if (!nonEmptySegments.length) return '';
  const sep = detectSeparator(nonEmptySegments[0]);
  return nonEmptySegments
    .map(segment =>
      segment
        .split(/[\\/]/)
        .filter(Boolean)
        .join(sep)
    )
    .join(sep);
};

const deleteExistingFilesFromDirs = async (
  project: gdProject,
  projectPath: string
): Promise<void> => {
  // If multiFile is not enabled in settings and directories do not exist.
  if (!project.isFolderProject()) return;

  const entries = await TauriBridge.readDir(projectPath);
  await Promise.all(
    entries
      .filter(
        entry =>
          entry.isDirectory && splittedProjectFolderNames.includes(entry.name)
      )
      .map(async entry => {
        const dirPath = await TauriBridge.join(projectPath, entry.name);
        const filenames = await TauriBridge.readDir(dirPath);
        await Promise.all(
          filenames.map(async file => {
            const fileToRemovePath = await TauriBridge.join(dirPath, file.name);
            try {
              await TauriBridge.remove(fileToRemovePath);
            } catch (e) {
              throw new Error(
                `Unable to remove file ${file.name}: ${e.message}`
              );
            }
          })
        );
      })
  );
};

const checkFileContent = async (
  filePath: string,
  expectedContent: string
): Promise<void> => {
  const time = performance.now();
  const content = await TauriBridge.readTextFile(filePath);

  if (content === '') {
    throw new Error(`Written file is empty, did the write fail?`);
  }
  if (content !== expectedContent) {
    throw new Error(
      `Written file is not containing the expected content, did the write fail?`
    );
  }
  const verificationTime = performance.now() - time;
  console.info(
    `Verified ${filePath} content in ${verificationTime.toFixed()}ms.`
  );
};

const writeAndCheckFile = async (
  content: string,
  filePath: string
): Promise<void> => {
  if (content === '')
    throw new Error('The content to save on disk is empty. Aborting.');

  // TauriBridge.writeTextFile creates missing parent directories itself
  // (mirrors fs-extra's ensureDir+writeFile, see contract §2).
  await TauriBridge.writeTextFile(filePath, content);
  await checkFileContent(filePath, content);
};

const writeAndCheckFormattedJSONFile = async (
  object: Object,
  filePath: string
): Promise<void> => {
  const content = addFinalNewline(JSON.stringify(object, null, 2));
  await writeAndCheckFile(content, filePath);
};

const writeProjectFiles = async ({
  project,
  filePath,
  projectPath,
  useBackgroundSerializer,
  canonicalEventSerialization,
}: {
  project: gdProject,
  filePath: string,
  projectPath: string,
  useBackgroundSerializer: boolean,
  canonicalEventSerialization: boolean,
}): Promise<void> => {
  const startTime = Date.now();

  let serializedProjectObject;
  if (useBackgroundSerializer) {
    // Canonical mode is currently not propagated to the background
    // serializer worker (which uses its own libGD instance). Background
    // serialization is hardcoded off in MainFrame so this is not
    // exercised in production yet.
    serializedProjectObject = await serializeToJSObjectInBackground(project);
  } else {
    serializedProjectObject = serializeToJSObject(project, 'serializeTo', {
      canonicalEventSerialization,
    });
  }
  const serializeEndTime = Date.now();

  if (project.isFolderProject()) {
    const partialObjects = split(serializedProjectObject, {
      pathSeparator: '/',
      getArrayItemReferenceName: getSlugifiedUniqueNameFromProperty('name'),
      shouldSplit: splitPaths(
        new Set(
          splittedProjectFolderNames.map(folderName => `/${folderName}/*`)
        )
      ),
      isReferenceMagicPropertyName: '__REFERENCE_TO_SPLIT_OBJECT',
    });

    await Promise.all(
      partialObjects.map(async partialObject => {
        const partialFilePath =
          (await TauriBridge.join(projectPath, partialObject.reference)) +
          '.json';
        try {
          await writeAndCheckFormattedJSONFile(
            partialObject.object,
            partialFilePath
          );
        } catch (err) {
          console.error('Unable to write a partial file:', err);
          throw err;
        }
      })
    );

    try {
      await writeAndCheckFormattedJSONFile(serializedProjectObject, filePath);
    } catch (err) {
      console.error('Unable to write the split project:', err);
      throw err;
    }
  } else {
    await writeAndCheckFormattedJSONFile(serializedProjectObject, filePath);
  }

  console.log(
    `[TauriProjectWriter] Project file(s) written in ${Date.now() -
      startTime}ms (including ${serializeEndTime - startTime}ms for ${
      useBackgroundSerializer ? 'background' : 'main'
    } thread serialization)`
  );
};

export const onSaveProject = async (
  project: gdProject,
  fileMetadata: FileMetadata,
  saveOptions?: SaveProjectOptions,
  actions: {|
    showAlert: ShowAlertFunction,
    showConfirmation: ShowConfirmFunction,
  |}
): Promise<{|
  wasSaved: boolean,
  fileMetadata: FileMetadata,
|}> => {
  const filePath = fileMetadata.fileIdentifier;
  const now = Date.now();
  if (!filePath) {
    throw new Error('Unable to find file path before saving.');
  }
  // Ensure we always pick the latest name and gameId.
  const newFileMetadata = {
    ...fileMetadata,
    name: project.getName(),
    gameId: project.getProjectUuid(),
    lastModifiedDate: now,
  };

  const projectPath = await TauriBridge.dirname(filePath);

  try {
    await deleteExistingFilesFromDirs(project, projectPath);
  } catch (e) {
    console.warn('Unable to clean project folder before saving project: ', e);
  }

  await writeProjectFiles({
    project,
    filePath,
    projectPath,
    useBackgroundSerializer:
      !!saveOptions && !!saveOptions.useBackgroundSerializer,
    canonicalEventSerialization:
      !!saveOptions && !!saveOptions.canonicalEventSerialization,
  });
  return {
    wasSaved: true,
    // $FlowFixMe[incompatible-type]
    fileMetadata: newFileMetadata,
  };
};

export const generateOnChooseSaveProjectAsLocation = ({
  setDialog,
  closeDialog,
}: {
  setDialog: (() => React.Node) => void,
  closeDialog: () => void,
}): (({
  displayOptionToGenerateNewProjectUuid: boolean,
  fileMetadata: ?FileMetadata,
  project: gdProject,
}) => Promise<{
  saveAsLocation: ?SaveAsLocation,
  saveAsOptions: ?SaveAsOptions,
}>) => async ({
  project,
  fileMetadata,
  displayOptionToGenerateNewProjectUuid,
}: {|
  project: gdProject,
  fileMetadata: ?FileMetadata, // This is the current location.
  displayOptionToGenerateNewProjectUuid: boolean,
|}): Promise<{|
  saveAsLocation: ?SaveAsLocation, // This is the newly chosen location (or null if cancelled).
  saveAsOptions: ?SaveAsOptions,
|}> => {
  const options = await new Promise(resolve => {
    setDialog(() => (
      <SaveAsOptionsDialog
        onCancel={() => {
          closeDialog();
          resolve(null);
        }}
        nameSuggestion={
          fileMetadata ? `${project.getName()} - Copy` : project.getName()
        }
        mainActionLabel={<Trans>Continue</Trans>}
        displayOptionToGenerateNewProjectUuid={
          displayOptionToGenerateNewProjectUuid
        }
        onSave={options => {
          closeDialog();
          resolve(options);
        }}
      />
    ));
  });

  if (!options) return { saveAsLocation: null, saveAsOptions: null }; // Save was cancelled.

  let defaultPath = fileMetadata ? fileMetadata.fileIdentifier : '';
  // $FlowFixMe[incompatible-use]
  const { name } = options;
  if (defaultPath && name) {
    const safeFilename = name.replace(/[<>:"/\\|?*]/g, '_');
    defaultPath = await TauriBridge.join(
      await TauriBridge.dirname(defaultPath),
      `${safeFilename}.json`
    );
  }

  const filePath = await TauriBridge.showSaveDialog({
    defaultPath,
    filters: [{ name: 'GDevelop 5 project', extensions: ['json'] }],
  });
  if (!filePath) {
    return { saveAsLocation: null, saveAsOptions: null };
  }

  // Must be called on EVERY save-as: the native save dialog only scopes the
  // chosen file itself, not the folder recursively, and nothing is written
  // there yet.
  await TauriBridge.allowProjectDirectory(await TauriBridge.dirname(filePath));

  return {
    saveAsLocation: {
      // $FlowFixMe[incompatible-use]
      name: options.name,
      fileIdentifier: filePath,
    },
    saveAsOptions: {
      // $FlowFixMe[incompatible-use]
      generateNewProjectUuid: options.generateNewProjectUuid,
    },
  };
};

export const onSaveProjectAs = async (
  project: gdProject,
  saveAsLocation: ?SaveAsLocation,
  options: {|
    onStartSaving: () => void,
    onMoveResources: ({|
      newFileMetadata: FileMetadata,
    |}) => Promise<void>,
  |}
): Promise<{|
  wasSaved: boolean,
  fileMetadata: ?FileMetadata,
|}> => {
  if (!saveAsLocation)
    throw new Error('A location was not chosen before saving as.');
  const filePath = saveAsLocation.fileIdentifier;
  if (!filePath)
    throw new Error('A file path was not chosen before saving as.');

  // Defensive re-grant: covers a save-as reached without going through
  // `generateOnChooseSaveProjectAsLocation` above (e.g: a programmatic
  // save-as location). `allowProjectDirectory` is idempotent.
  await TauriBridge.allowProjectDirectory(await TauriBridge.dirname(filePath));

  options.onStartSaving();

  // Ensure we always pick the latest name and gameId.
  const newFileMetadata = {
    fileIdentifier: filePath,
    name: project.getName(),
    gameId: project.getProjectUuid(),
    lastModifiedDate: Date.now(),
  };

  // Move (copy or download, etc...) the resources first.
  // $FlowFixMe[incompatible-type]
  await options.onMoveResources({ newFileMetadata });

  // Save the project when resources have been copied.
  const projectPath = await TauriBridge.dirname(filePath);
  project.setProjectFile(filePath);

  await writeProjectFiles({
    project,
    filePath,
    projectPath,
    useBackgroundSerializer: false,
    // SaveAs is a one-off operation: the user will typically save again
    // through the normal onSaveProject path, which honors the preference.
    canonicalEventSerialization: false,
  });
  return {
    wasSaved: true,
    // $FlowFixMe[incompatible-type]
    fileMetadata: newFileMetadata,
  };
};

export const onAutoSaveProject = async (
  project: gdProject,
  fileMetadata: FileMetadata
): Promise<void> => {
  const autoSavePath = fileMetadata.fileIdentifier + '.autosave';
  try {
    await writeAndCheckFile(serializeToJSON(project), autoSavePath);
  } catch (err) {
    console.error(`Unable to write ${autoSavePath}:`, err);
    throw err;
  }
};

export const getWriteErrorMessage = (error: Error): MessageDescriptor =>
  t`An error occurred when saving the project. Please try again by choosing another location.`;

// See https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
const forbiddenCharacterRegex = /\\ | \/ | : | \* | \? | " | < | > | \|/g;
const consecutiveSpacesRegex = /\s+/g;
const cleanUpProjectFileName = (projectFileName: string) =>
  (projectFileName.length > 200
    ? projectFileName.substring(0, 200)
    : projectFileName
  )
    .replace(forbiddenCharacterRegex, ' ')
    .replace(consecutiveSpacesRegex, ' ')
    .trim();

export const getProjectLocation = ({
  projectName,
  saveAsLocation,
  newProjectsDefaultFolder,
}: {
  projectName: string,
  saveAsLocation: ?SaveAsLocation,
  newProjectsDefaultFolder?: string,
}): SaveAsLocation => {
  const outputPath = saveAsLocation
    ? dirnameSync(saveAsLocation.fileIdentifier || '')
    : newProjectsDefaultFolder
    ? newProjectsDefaultFolder
    : '';
  const projectFileName = projectName
    ? cleanUpProjectFileName(projectName) + '.json'
    : 'game.json';
  return {
    fileIdentifier: joinSync(outputPath, projectFileName),
  };
};

export const renderNewProjectSaveAsLocationChooser = ({
  projectName,
  saveAsLocation,
  setSaveAsLocation,
  newProjectsDefaultFolder,
}: {|
  projectName: string,
  saveAsLocation: ?SaveAsLocation,
  setSaveAsLocation: (?SaveAsLocation) => void,
  newProjectsDefaultFolder?: string,
|}): React.Node => {
  const projectLocation = getProjectLocation({
    projectName,
    saveAsLocation,
    newProjectsDefaultFolder,
  });
  return (
    <TauriFolderPicker
      fullWidth
      value={dirnameSync(projectLocation.fileIdentifier || '')}
      onChange={newOutputPath => {
        const newOutputFileIdentifier = joinSync(
          newOutputPath,
          basenameSync(projectLocation.fileIdentifier || '')
        );
        setSaveAsLocation(
          getProjectLocation({
            projectName,
            saveAsLocation: {
              fileIdentifier: newOutputFileIdentifier,
            },
            newProjectsDefaultFolder,
          })
        );
      }}
      type="create-game"
    />
  );
};

export const canFileMetadataBeSafelySavedAs = async (
  fileMetadata: FileMetadata,
  actions: {|
    showAlert: ShowAlertFunction,
    showConfirmation: ShowConfirmFunction,
  |}
): Promise<boolean> => {
  // Electron's equivalent blocks saving inside the app's own install
  // directory, to avoid losing the project on an app update. TauriBridge
  // exposes no app/install-path equivalent, so always allowed here.
  return true;
};
