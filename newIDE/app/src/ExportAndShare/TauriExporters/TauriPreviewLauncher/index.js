// @flow
import * as React from 'react';
import assignIn from 'lodash/assignIn';
import BrowserPreviewErrorDialog from '../../BrowserExporters/BrowserPreview/BrowserPreviewErrorDialog';
import { findGDJS } from '../../../GameEngineFinder/BrowserS3GDJSFinder';
import TauriExportFileSystem from '../TauriExportFileSystem';
import {
  type PreviewOptions,
  type PreviewLauncherProps,
} from '../../PreviewLauncher.flow';
import Window from '../../../Utils/Window';
import { getIDEVersionWithHash } from '../../../Version';
import TauriBridge, { type TauriBridgeEnv } from '../../../Utils/Tauri/TauriBridge';

const gd: libGDevelop = global.gd;

let nextPreviewId = 1;

type State = {|
  error: ?Error,
|};

// Exports into an in-memory TauriExportFileSystem rooted at the app's
// preview cache dir, fetching GDJS from the network like the Browser build
// (no offline preview yet).
const prepareExporter = async (
  env: TauriBridgeEnv
): Promise<{|
  outputDir: string,
  exporter: gdjsExporter,
  tauriExportFileSystem: TauriExportFileSystem,
|}> => {
  const { gdjsRoot, filesContent } = await findGDJS('preview');
  console.info('GDJS found in ', gdjsRoot);

  const outputDir = `${env.appCacheDir}${env.pathSeparator}preview`;
  const tauriExportFileSystem = new TauriExportFileSystem({
    textFiles: filesContent,
    rootDir: outputDir,
  });
  const fileSystem = assignIn(
    new gd.AbstractFileSystemJS(),
    tauriExportFileSystem
  );
  const exporter = new gd.Exporter(fileSystem, gdjsRoot);
  exporter.setCodeOutputDirectory(outputDir);

  return { outputDir, exporter, tauriExportFileSystem };
};

/**
 * Launches previews in a second Tauri window, served by a local preview
 * server. No debugger, hot reload, network preview or screenshot capture
 * yet - a preview must still run without them.
 */
export default class TauriPreviewLauncher extends React.Component<
  PreviewLauncherProps,
  State
> {
  state: State = {
    error: null,
  };

  canDoNetworkPreview = (): boolean => false;

  getPreviewDebuggerServer(): any {
    return null; // No debugger server yet; callers already handle null.
  }

  closeAllPreviews = (): void => {
    TauriBridge.closeAllPreviewWindows().catch(error => {
      console.info('Unable to close all preview windows - ignoring.', error);
    });
  };

  launchPreview = async (previewOptions: PreviewOptions): Promise<any> => {
    this.setState({ error: null });

    if (previewOptions.isForGameplayTest || previewOptions.isForInGameEdition) {
      // Both need the embedded game frame and the debugger server, neither
      // available yet.
      console.warn(
        '[TauriPreviewLauncher] Gameplay tests and in-game edition are not supported yet on Tauri - ignoring this preview request.'
      );
      return;
    }

    const previewId = nextPreviewId++;
    console.log(
      `[TauriPreviewLauncher] Launching preview #${previewId} with options:`,
      previewOptions
    );

    const {
      project,
      sceneName,
      externalLayoutName,
      eventsBasedObjectType,
      eventsBasedObjectVariantName,
      numberOfWindows,
    } = previewOptions;

    try {
      const env = await TauriBridge.init(); // Idempotent, cheap to call again.

      const {
        outputDir,
        exporter,
        tauriExportFileSystem,
      } = await prepareExporter(env);

      const previewExportOptions = new gd.PreviewExportOptions(
        project,
        outputDir
      );
      previewExportOptions.setIsDevelopmentEnvironment(Window.isDev());
      previewExportOptions.setLayoutName(sceneName);
      previewExportOptions.setEditorId(previewOptions.editorId || '');
      if (externalLayoutName) {
        previewExportOptions.setExternalLayoutName(externalLayoutName);
      }
      if (eventsBasedObjectType) {
        previewExportOptions.setEventsBasedObjectType(eventsBasedObjectType);
        previewExportOptions.setEventsBasedObjectVariantName(
          eventsBasedObjectVariantName || ''
        );
      }

      previewExportOptions.useMinimalDebuggerClient(); // No debugger server yet.

      const includeFileHashs = this.props.getIncludeFileHashs();
      for (const includeFile in includeFileHashs) {
        previewExportOptions.setIncludeFileHash(
          includeFile,
          includeFileHashs[includeFile]
        );
      }

      previewExportOptions.setFullLoadingScreen(
        previewOptions.fullLoadingScreen
      );
      previewExportOptions.setGDevelopVersionWithHash(getIDEVersionWithHash());
      previewExportOptions.setCrashReportUploadLevel(
        this.props.crashReportUploadLevel
      );
      previewExportOptions.setPreviewContext('preview');
      previewExportOptions.setProjectTemplateSlug(project.getTemplateSlug());

      if (previewOptions.inAppTutorialMessageInPreview) {
        previewExportOptions.setInAppTutorialMessageInPreview(
          previewOptions.inAppTutorialMessageInPreview,
          previewOptions.inAppTutorialMessagePositionInPreview
        );
      }
      if (previewOptions.fallbackAuthor) {
        previewExportOptions.setFallbackAuthor(
          previewOptions.fallbackAuthor.id,
          previewOptions.fallbackAuthor.username
        );
      }
      if (previewOptions.authenticatedPlayer) {
        previewExportOptions.setAuthenticatedPlayer(
          previewOptions.authenticatedPlayer.playerId,
          previewOptions.authenticatedPlayer.playerUsername,
          previewOptions.authenticatedPlayer.playerToken
        );
      }
      if (previewOptions.editorCameraState3D) {
        previewExportOptions.setEditorCameraState3D(
          previewOptions.editorCameraState3D.cameraMode,
          previewOptions.editorCameraState3D.positionX,
          previewOptions.editorCameraState3D.positionY,
          previewOptions.editorCameraState3D.positionZ,
          previewOptions.editorCameraState3D.rotationAngle,
          previewOptions.editorCameraState3D.elevationAngle,
          previewOptions.editorCameraState3D.distance
        );
      }
      if (previewOptions.inGameEditorSettings) {
        previewExportOptions.setInGameEditorSettingsJson(
          JSON.stringify(previewOptions.inGameEditorSettings)
        );
      }
      // previewOptions.captureOptions is intentionally never read: no
      // screenshot capture yet.

      exporter.exportProjectForPixiPreview(previewExportOptions);
      previewExportOptions.delete();
      exporter.delete();

      // Writes staged files to disk and downloads any URL-referenced ones.
      const flushResult = await tauriExportFileSystem.flush({
        outputDir,
        clearOutputDir: true,
      });
      if (flushResult.failures.length) {
        console.error(
          `[TauriPreviewLauncher] Preview #${previewId}: ${
            flushResult.failures.length
          } file(s) failed to flush.`,
          flushResult.failures
        );
      }

      const server = await TauriBridge.startPreviewServer(outputDir);

      const windowsToOpen = Math.max(1, numberOfWindows || 1);
      for (let i = 0; i < windowsToOpen; i++) {
        await TauriBridge.openPreviewWindow({
          url: server.origin + '/index.html',
          title: `Preview of ${project.getName()}`,
          width: project.getGameResolutionWidth(),
          height: project.getGameResolutionHeight(),
          alwaysOnTop: previewOptions.getIsAlwaysOnTopInPreview(),
        });
      }
    } catch (error) {
      console.error(
        `[TauriPreviewLauncher] Preview #${previewId} failed:`,
        error
      );
      this.setState({ error });
    }

    const previewStopTime = performance.now();
    console.info(
      `[TauriPreviewLauncher] Preview #${previewId} launch finished at ${previewStopTime}ms`
    );
  };

  render(): any {
    const { error } = this.state;

    if (error) {
      return (
        <BrowserPreviewErrorDialog
          error={error}
          onClose={() => this.setState({ error: null })}
        />
      );
    }

    return null;
  }
}
