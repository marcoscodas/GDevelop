// @flow
import * as React from 'react';
import { t } from '@lingui/macro';
import { type StorageProvider } from '../index';
import {
  onOpenWithPicker,
  onOpen,
  getAutoSaveCreationDate,
  onGetAutoSave,
} from './TauriProjectOpener';
import {
  onSaveProject,
  generateOnChooseSaveProjectAsLocation,
  onSaveProjectAs,
  onAutoSaveProject,
  getWriteErrorMessage,
  renderNewProjectSaveAsLocationChooser,
  getProjectLocation,
  canFileMetadataBeSafelySavedAs,
} from './TauriProjectWriter';
import {
  type AppArguments,
  POSITIONAL_ARGUMENTS_KEY,
} from '../../Utils/Window';
import { type MessageDescriptor } from '../../Utils/i18n/MessageDescriptor.flow';
import Computer from '../../UI/CustomSvgIcons/Computer';
import { localFileStorageProviderInternalName } from '../LocalFileStorageProvider/LocalFileStorageProviderInternalName';

/**
 * Uses TauriBridge (native dialogs + fs) to provide access to the native
 * file system, as a replacement for LocalFileStorageProvider under Tauri.
 *
 * `internalName` is the same `'LocalFile'` constant as the Electron
 * provider (imported, never redefined): recent files and the resource
 * fetcher/mover maps key off this string regardless of which provider is
 * actually registered.
 *
 * No resources watcher, no locate/scan-for-resources, no adding resources
 * from disk to an already-open project yet.
 */
export default ({
  internalName: localFileStorageProviderInternalName,
  name: t`Your computer`,
  renderIcon: props => <Computer fontSize={props.size} />,
  getFileMetadataFromAppArguments: (appArguments: AppArguments) => {
    if (!appArguments[POSITIONAL_ARGUMENTS_KEY]) return null;
    if (!appArguments[POSITIONAL_ARGUMENTS_KEY].length) return null;

    return {
      fileIdentifier: appArguments[POSITIONAL_ARGUMENTS_KEY][0],
    };
  },
  getProjectLocation: getProjectLocation,
  renderNewProjectSaveAsLocationChooser: renderNewProjectSaveAsLocationChooser,
  createOperations: ({ setDialog, closeDialog }) => ({
    onOpenWithPicker,
    onOpen,
    getAutoSaveCreationDate,
    onSaveProject,
    onChooseSaveProjectAsLocation: generateOnChooseSaveProjectAsLocation({
      setDialog,
      closeDialog,
    }),
    onSaveProjectAs,
    onAutoSaveProject,
    onGetAutoSave,
    getOpenErrorMessage: (error: Error): MessageDescriptor => {
      return t`Check that the file exists, that this file is a proper game created with GDevelop and that you have the authorization to open it.`;
    },
    getWriteErrorMessage,
    canFileMetadataBeSafelySavedAs,
  }),
}: StorageProvider);
