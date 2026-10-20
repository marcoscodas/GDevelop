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
 * Use TauriBridge (native dialogs + fs over Tauri plugins/commands) to
 * provide access to the native file system, as a replacement for
 * LocalFileStorageProvider under Tauri.
 *
 * `internalName` is intentionally the *same* `'LocalFile'` constant as the
 * Electron provider (imported, never redefined - ADR-001 §3 B3 correction):
 * over a dozen call sites key off this string (recent files, resource
 * fetcher/mover maps, etc) and must keep working whichever of the two
 * providers (Electron or Tauri) is actually registered by the running app.
 *
 * Out of MVP (ADR-001 §1/§3 B3), left entirely absent here (same as the
 * Browser storage provider), not stubbed:
 *  - `setupResourcesWatcher` (the resources watcher)
 *  - `createResourceOperations` (locate file / open file in OS / scan project
 *    folder for new resources / "remove resources with invalid path" menu
 *    entries)
 *  - adding new resources from disk to an already-open local project
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
