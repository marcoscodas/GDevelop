// @flow
import * as React from 'react';
import MainFrame from './MainFrame';
import Window from './Utils/Window';
import ShareDialog from './ExportAndShare/ShareDialog';
import Authentication from './Utils/GDevelopServices/Authentication';
import './UI/icomoon-font.css'; // Styles for Icomoon font.

// Resource sources, extensions loader, login provider and the Share dialog
// exporters are reused from the Browser build; only storage, preview,
// resource moving and events code generation are Tauri-native.
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

// Tauri never registers a Service Worker, but unregisters any leftover one
// defensively - best-effort, must not block startup either way.
const unregisterAnyExistingServiceWorkers = () => {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

  navigator.serviceWorker
    .getRegistrations()
    .then(registrations => {
      registrations.forEach(registration => {
        registration.unregister().catch(() => {});
      });
    })
    .catch(() => {});
};

type ContentProps = {|
  authentication: Authentication,
  env: TauriBridgeEnv,
|};

// Rendered once TauriBridge.init() resolves. Always uses TauriPreviewLauncher,
// never the Service-Worker-based preview path BrowserApp picks.
const TauriAppContent = ({ authentication, env }: ContentProps): React.Node => {
  Window.setUpContextMenu();
  const loginProvider = new BrowserLoginProvider(authentication.auth);
  authentication.setLoginProvider(loginProvider);

  const appArguments = Window.getArguments();

  return (
    <Providers
      authentication={authentication}
      disableCheckForUpdates={!!appArguments['disable-update-check']}
      // env is needed to build include paths synchronously.
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

// create() stays synchronous like BrowserApp/LocalApp, so TauriBridge.init()
// is awaited here instead: nothing Tauri-native renders until it resolves.
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
