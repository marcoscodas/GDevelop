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
// TauriBridge does not exist yet in this worktree (B1's deliverable,
// written in parallel - see ADR-001-tauri-mvp.md §3 and
// TauriBridge-contract.md). This import is correct per the contract and
// will resolve once Gate 1 merges B1. Per the Wave-1 lint rule (contract
// §6), TauriBridge.js is the only file allowed to import `@tauri-apps/*` or
// call `optionalRequire` for platform access: every other Tauri file,
// including this one, goes through it instead.
import TauriBridge, {
  type TauriBridgeEnv,
  type Unlisten,
} from '../../../Utils/Tauri/TauriBridge';

const gd: libGDevelop = global.gd;

let nextPreviewId = 1;

type State = {|
  error: ?Error,
|};

/**
 * Export the project into an in-memory TauriExportFileSystem rooted at
 * `${env.appCacheDir}/preview` (TauriBridge-contract.md §4), using the
 * Browser/S3 GDJS finder: offline preview is out of MVP scope
 * (ADR-001-tauri-mvp.md §1) because the GDJS runtime is fetched from
 * `resources.gdevelop-app.com`, same as the Browser build. Bundling GDJS as
 * a Tauri resource (which would let `LocalGDJSFinder` be reused instead) is
 * deferred to a later wave.
 */
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
 * Launches previews in a second Tauri window, served by the local preview
 * server (ADR-001-tauri-mvp.md §1 item 5 - the only MVP approach; the
 * service-worker preview is ruled out on every platform, and the S3/network
 * preview needs a cloud upload per preview).
 *
 * Out of scope for this launcher (ADR-001 §3, B4): the debugger server
 * (so hot reload isn't available either), network preview, and screenshot
 * capture. None of these must crash the preview - "a preview that fails to
 * reach the debugger must still run" - so they're simply never wired up
 * here instead of being half-implemented.
 */
export default class TauriPreviewLauncher extends React.Component<
  PreviewLauncherProps,
  State
> {
  state: State = {
    error: null,
  };

  // Labels of the currently open preview windows, so closeAllPreviews can
  // close exactly those (closeAllPreviewWindows is also available and used
  // directly, this set is only kept for completeness/future use, e.g. a
  // per-window close action).
  _openPreviewWindowLabels: Set<string> = new Set();
  _unlistenPreviewWindowClosed: ?Unlisten = null;

  canDoNetworkPreview = (): boolean => false;

  getPreviewDebuggerServer(): any {
    // Debugger server integration is out of scope for this launcher
    // (ADR-001-tauri-mvp.md §3, B4). Returning null is the documented
    // "no debugger available" case for PreviewLauncherInterface - callers
    // (e.g. hot reload, the Debugger editor) already handle it.
    return null;
  }

  closeAllPreviews = (): void => {
    TauriBridge.closeAllPreviewWindows()
      .then(() => {
        this._openPreviewWindowLabels.clear();
      })
      .catch(error => {
        console.info('Unable to close all preview windows - ignoring.', error);
      });
  };

  _unsubscribePreviewWindowClosed = () => {
    if (this._unlistenPreviewWindowClosed) {
      this._unlistenPreviewWindowClosed();
      this._unlistenPreviewWindowClosed = null;
    }
  };

  componentWillUnmount() {
    this._unsubscribePreviewWindowClosed();
  }

  launchPreview = async (previewOptions: PreviewOptions): Promise<any> => {
    this.setState({ error: null });

    if (previewOptions.isForGameplayTest || previewOptions.isForInGameEdition) {
      // Gameplay tests and in-game edition rely on an embedded game frame
      // and the debugger server, both out of MVP scope for Tauri
      // (ADR-001-tauri-mvp.md §1). Ignore rather than crash.
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
      // Idempotent: cheap to call again rather than threading `env` through
      // props (TauriBridge-contract.md §4 leaves the choice to B4).
      const env = await TauriBridge.init();

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

      // No debugger server is started for Tauri previews (out of scope,
      // see class doc comment): use the minimal client so the game still
      // runs without trying to reach one.
      previewExportOptions.useMinimalDebuggerClient();

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
      // Screenshot capture is out of scope for this launcher (ADR-001 §3,
      // B4): previewOptions.captureOptions is intentionally never read.

      exporter.exportProjectForPixiPreview(previewExportOptions);
      previewExportOptions.delete();
      exporter.delete();

      // Write the staged files to real disk, and have Rust download the
      // GDJS runtime files referenced by URL, in one IPC call
      // (TauriBridge-contract.md §1). Start fresh each time, like the
      // other preview launchers.
      const flushResult = await tauriExportFileSystem.flush({
        outputDir,
        clearOutputDir: true,
      });
      if (flushResult.failures.length) {
        // A missing resource must not kill the preview (contract §1).
        console.error(
          `[TauriPreviewLauncher] Preview #${previewId}: ${
            flushResult.failures.length
          } file(s) failed to flush.`,
          flushResult.failures
        );
      }

      const server = await TauriBridge.startPreviewServer(outputDir);

      this._unsubscribePreviewWindowClosed();
      this._unlistenPreviewWindowClosed = await TauriBridge.onPreviewWindowClosed(
        label => {
          this._openPreviewWindowLabels.delete(label);
        }
      );

      const windowsToOpen = Math.max(1, numberOfWindows || 1);
      for (let i = 0; i < windowsToOpen; i++) {
        const handle = await TauriBridge.openPreviewWindow({
          url: server.origin + '/index.html',
          title: `Preview of ${project.getName()}`,
          width: project.getGameResolutionWidth(),
          height: project.getGameResolutionHeight(),
          alwaysOnTop: previewOptions.getIsAlwaysOnTopInPreview(),
        });
        this._openPreviewWindowLabels.add(handle.label);
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
