// @flow
import TauriBridge from '../../Utils/Tauri/TauriBridge';
import { type FileMetadata } from '../index';
import { unsplit } from '../../Utils/ObjectSplitter';

/**
 * Tauri equivalent of LocalProjectOpener.js, using TauriBridge instead of
 * `fs`/`electron.remote.dialog`. See TauriBridge-contract.md §4 (B3).
 */

const readJSONFile = async (filePath: string): Promise<Object> => {
  try {
    const content = await TauriBridge.readTextFile(filePath);
    return JSON.parse(content);
  } catch (ex) {
    throw new Error(filePath + ' is a corrupted/malformed file.');
  }
};

export const onOpenWithPicker = async (): Promise<?FileMetadata> => {
  const filePaths = await TauriBridge.showOpenDialog({
    title: 'Open a project',
    filters: [{ name: 'GDevelop 5 project', extensions: ['json'] }],
  });
  if (!filePaths || !filePaths.length) return null;

  const fileIdentifier = filePaths[0];

  // Granting access as soon as a file is picked is harmless even though
  // `onOpen` (called right after by the caller) grants it again: the
  // extension is idempotent and this keeps the behavior correct even if
  // this function is ever called on its own.
  await TauriBridge.allowProjectDirectory(
    await TauriBridge.dirname(fileIdentifier)
  );

  return { fileIdentifier };
};

export const onOpen = async (
  fileMetadata: FileMetadata
): Promise<{|
  content: Object,
|}> => {
  const filePath = fileMetadata.fileIdentifier;
  const projectPath = await TauriBridge.dirname(filePath);

  // Must be called on EVERY project open (ADR-001 §3 B3 / contract §4):
  // this is the only path that covers opens from the recent-projects list
  // and from the autosave flow, neither of which goes through the native
  // open dialog (which would only scope the single picked file anyway).
  await TauriBridge.allowProjectDirectory(projectPath);

  const object = await readJSONFile(filePath);
  await unsplit(object, {
    getReferencePartialObject: async (referencePath: string) => {
      const referenceFilePath =
        (await TauriBridge.join(projectPath, referencePath)) + '.json';
      return readJSONFile(referenceFilePath);
    },
    isReferenceMagicPropertyName: '__REFERENCE_TO_SPLIT_OBJECT',
    // Limit unsplitting to depth 3 (which would allow properties of layouts/external layouts/external events
    // to be un-splitted, but not the content of these properties), to avoid very slow processing
    // of large game files.
    maxUnsplitDepth: 3,
  });

  return { content: object };
};

export const getAutoSaveCreationDate = async (
  fileMetadata: FileMetadata,
  compareLastModified: boolean
): Promise<?number> => {
  const filePath = fileMetadata.fileIdentifier;
  const autoSavePath = filePath + '.autosave';

  // This can run before `onOpen` (to decide whether to offer restoring the
  // autosave), so the project directory might not be scoped yet.
  await TauriBridge.allowProjectDirectory(await TauriBridge.dirname(filePath));

  const autoSaveStat = await TauriBridge.stat(autoSavePath);
  if (!autoSaveStat) return null;

  const autoSavedTime = autoSaveStat.mtimeMs;
  if (!compareLastModified) {
    return autoSavedTime;
  }
  try {
    const fileStat = await TauriBridge.stat(filePath);
    const saveTime = fileStat ? fileStat.mtimeMs : 0;
    // When comparing the last modified time, add a 5 seconds margin to avoid
    // showing the warning if the user has just saved the project, or if the
    // project has been decompressed from a zip file, causing the last modified
    // time to be the time of decompression.
    return autoSavedTime > saveTime + 5000 ? autoSavedTime : null;
  } catch (err) {
    console.error('Unable to compare *.autosave to project', err);
    return null;
  }
};

export const onGetAutoSave = (
  fileMetadata: FileMetadata
): Promise<{
  fileIdentifier: string,
  gameId?: string,
  lastModifiedDate?: number,
  name?: string,
  ownerId?: string,
  version?: string,
}> => {
  return Promise.resolve({
    ...fileMetadata,
    fileIdentifier: fileMetadata.fileIdentifier + '.autosave',
  });
};
