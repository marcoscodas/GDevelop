// @flow
import * as React from 'react';
import MainFrame from './MainFrame';
import Window from './Utils/Window';
import ShareDialog from './ExportAndShare/ShareDialog';
import Authentication from './Utils/GDevelopServices/Authentication';
import './UI/icomoon-font.css'; // Styles for Icomoon font.

// Reused as-is from the Browser build for the MVP (ADR-001 §1/§3: resource
// sources, extensions loader, login provider and the Share dialog exporters
// stay Browser's versions - only storage/preview/resource-move/events-code
// are Tauri-native in Wave 1).
import browserResourceSources from './ResourcesList/BrowserResourceSources';
import browserResourceExternalEditors from './ResourcesList/BrowserResourceExternalEditors';
import {
  browserAutomatedExporters,
  browserManualExporters,
  browserOnlineWebExporter,
} from './ExportAndShare/BrowserExporters';
import makeExtensionsLoader from './JsExtensionsLoader/BrowserJsExtensionsLoader';
import ObjectsEditorService from './ObjectEditor/ObjectsEditorService';
import ObjectsRenderingService from './ObjectsRendering/ObjectsRenderingService';
import Providers from './MainFrame/Providers';
import ProjectStorageProviders from './ProjectsStorage/ProjectStorageProviders';
import UrlStorageProvider from './ProjectsStorage/UrlStorageProvider';
import CloudStorageProvider from './ProjectsStorage/CloudStorageProvider';
import BrowserEventsFunctionsExtensionOpener from './EventsFunctionsExtensionsLoader/Storage/BrowserEventsFunctionsExtensionOpener';
import BrowserEventsFunctionsExtensionWriter from './EventsFunctionsExtensionsLoader/Storage/BrowserEventsFunctionsExtensionWriter';
import BrowserLoginProvider from './LoginProvider/BrowserLoginProvider';

import TauriBridge, { type TauriBridgeEnv } from './Utils/Tauri/TauriBridge';

import TauriFileStorageProvider from './ProjectsStorage/TauriFileStorageProvider';
import TauriResourceFetcher from './ProjectsStorage/ResourceFetcher/TauriResourceFetcher';
import TauriResourceMover from './ProjectsStorage/ResourceMover/TauriResourceMover';
import TauriPreviewLauncher from './ExportAndShare/TauriExporters/TauriPreviewLauncher';
import { makeTauriEventsFunctionCodeWriter } from './EventsFunctionsExtensionsLoader/CodeWriters/TauriEventsFunctionCodeWriter';

const styles = {
  loadingMessage: {
    position: 'absolute',
    top: 'calc(50% + 80px)',
    left: 15,
    right: 15,
    fontSize: 20,
    fontFamily: 'sans-serif',
    color: 'darkgray',
    textAlign: 'center',
  },
};

/**
 * Defensively unregister any Service Worker registration that may already
 * exist (ADR-001 §1 item 7 / §4.1). Tauri must never end up running with a
 * Workbox SW caching bundles across app updates, on any platform: WebKitGTK
 * is known to fail registration outright (S1), and WebView2's behaviour is
 * unverified, so this guards both cases rather than assuming either.
 */
const unregisterAnyExistingServiceWorkers = () => {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

  navigator.serviceWorker
    .getRegistrations()
    .then(registrations => {
      registrations.forEach(registration => {
        // Best-effort: there is no registration to unregister on most
        // platforms (that's the point of this function), so a rejection
        // here is the expected case, not an error to surface.
        registration.unregister().catch(() => {});
      });
    })
    // Startup must not depend on this diagnostic cleanup succeeding; the SW
    // APIs themselves being unsupported/erroring is not a reason to block
    // rendering the editor.
    .catch(() => {});
};

type ContentProps = {|
  authentication: Authentication,
  env: TauriBridgeEnv,
|};

/**
 * The actual composition root, rendered once TauriBridge.init() has
 * resolved. Copied in spirit from BrowserApp.js, with the non-SW path
 * hard-coded (ADR-001 §2.7): this never calls ensureBrowserSWPreviewSession()
 * and never picks BrowserSWPreviewLauncher - TauriPreviewLauncher (B4) is the
 * only preview launcher TauriApp ever renders.
 */
const TauriAppContent = ({ authentication, env }: ContentProps): React.Node => {
  Window.setUpContextMenu();
  const loginProvider = new BrowserLoginProvider(authentication.auth);
  authentication.setLoginProvider(loginProvider);

  const appArguments = Window.getArguments();

  return (
    <Providers
      authentication={authentication}
      disableCheckForUpdates={!!appArguments['disable-update-check']}
      // makeTauriEventsFunctionCodeWriter (B4) takes the resolved bridge env
      // alongside the callbacks, so it can build include paths synchronously.
      makeEventsFunctionCodeWriter={callbacks =>
        makeTauriEventsFunctionCodeWriter({ ...callbacks, env })
      }
      // $FlowFixMe[incompatible-type]
      // $FlowFixMe[incompatible-exact]
      eventsFunctionsExtensionWriter={BrowserEventsFunctionsExtensionWriter}
      // $FlowFixMe[incompatible-type]
      // $FlowFixMe[incompatible-exact]
      eventsFunctionsExtensionOpener={BrowserEventsFunctionsExtensionOpener}
    >
      {({ i18n }) => (
        <ProjectStorageProviders
          appArguments={appArguments}
          storageProviders={[
            TauriFileStorageProvider,
            UrlStorageProvider,
            CloudStorageProvider,
          ]}
          defaultStorageProvider={TauriFileStorageProvider}
        >
          {({
            getStorageProviderOperations,
            getStorageProviderResourceOperations,
            storageProviders,
            initialFileMetadataToOpen,
            getStorageProvider,
          }) => (
            <MainFrame
              i18n={i18n}
              useCliCommandRunner={() => {}}
              renderPreviewLauncher={(props, ref) => (
                // $FlowFixMe[incompatible-type]
                <TauriPreviewLauncher {...props} ref={ref} />
              )}
              renderShareDialog={props => (
                <ShareDialog
                  project={props.project}
                  onSaveProject={props.onSaveProject}
                  isSavingProject={props.isSavingProject}
                  onChangeSubscription={props.onChangeSubscription}
                  onClose={props.onClose}
                  automatedExporters={browserAutomatedExporters}
                  manualExporters={browserManualExporters}
                  onlineWebExporter={browserOnlineWebExporter}
                  allExportersRequireOnline
                  fileMetadata={props.fileMetadata}
                  storageProvider={props.storageProvider}
                  initialTab={props.initialTab}
                  gamesList={props.gamesList}
                />
              )}
              storageProviders={storageProviders}
              resourceMover={TauriResourceMover}
              resourceFetcher={TauriResourceFetcher}
              getStorageProviderOperations={getStorageProviderOperations}
              getStorageProviderResourceOperations={
                getStorageProviderResourceOperations
              }
              getStorageProvider={getStorageProvider}
              resourceSources={browserResourceSources}
              resourceExternalEditors={browserResourceExternalEditors}
              extensionsLoader={makeExtensionsLoader({
                objectsEditorService: ObjectsEditorService,
                objectsRenderingService: ObjectsRenderingService,
                filterExamples: !Window.isDev(),
              })}
              initialFileMetadataToOpen={initialFileMetadataToOpen}
              initialExampleSlugToOpen={
                appArguments['create-from-example'] || null
              }
            />
          )}
        </ProjectStorageProviders>
      )}
    </Providers>
  );
};

type BootstrapperProps = {| authentication: Authentication |};
type BootstrapperState = {| env: ?TauriBridgeEnv, error: ?Error |};

/**
 * `index.js` awaits only the dynamic `import('./TauriApp')`, not a further
 * promise from `create()` (mirroring BrowserApp/LocalApp's synchronous
 * `create()` keeps index.js's two-line diff, see ADR-001 §2.2). So the
 * `TauriBridge.init()` round-trip this file must await (per the bridge
 * contract: "TauriApp awaits this before create()") happens here instead,
 * inside componentDidMount: nothing Tauri-native (storage providers,
 * preview launcher, MainFrame) is rendered until it resolves.
 */
class TauriAppBootstrapper extends React.Component<
  BootstrapperProps,
  BootstrapperState
> {
  state: BootstrapperState = { env: null, error: null };

  componentDidMount() {
    unregisterAnyExistingServiceWorkers();

    TauriBridge.init()
      .then(env => this.setState({ env }))
      .catch(error => this.setState({ error }));
  }

  render(): React.Node {
    const { env, error } = this.state;

    if (error) {
      return (
        <div style={styles.loadingMessage}>
          Unable to initialize the GDevelop desktop app ({error.message}).
          Please restart the application.
        </div>
      );
    }

    if (!env) {
      return <div style={styles.loadingMessage}>Loading...</div>;
    }

    return (
      <TauriAppContent authentication={this.props.authentication} env={env} />
    );
  }
}

export const create = (authentication: Authentication): React.Node => (
  <TauriAppBootstrapper authentication={authentication} />
);
