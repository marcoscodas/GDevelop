// @flow
import Window from '../Utils/Window';
import { getIDEVersionWithHash } from '../Version';
import TauriBridge from '../Utils/Tauri/TauriBridge';
import { isTauri } from '../Utils/Tauri/isTauri';

const base64ToText = (base64: string): string => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
};

/**
 * `fetch(url).then(response => response.text())`, but routed through Rust
 * under Tauri (TauriBridge-contract.md section 7): the webview would
 * otherwise block reading this response, since `resources.gdevelop-app.com`
 * almost certainly doesn't have this app's origin CORS-allowlisted. Safe to
 * route this specific fetch through Rust because these are plain public
 * runtime files with no cookie/credentials dependency - unlike, say,
 * Utils/BlobDownloader.js's `credentials: 'include'` fetches, which rely on
 * a browser-managed cookie a Rust HTTP client has no access to at all and
 * must NOT be blindly proxied the same way.
 */
const fetchText = (url: string): Promise<string> => {
  if (!isTauri()) {
    return fetch(url).then(response => {
      if (!response.ok) {
        console.error(`Error while downloading "${url}"`, response);
        throw new Error(
          `Error while downloading "${url}" (status: ${response.status})`
        );
      }
      return response.text();
    });
  }

  return TauriBridge.httpFetch({ method: 'GET', url, headers: {} }).then(
    result => {
      if (result.status < 200 || result.status >= 300) {
        console.error(`Error while downloading "${url}"`, result);
        throw new Error(
          `Error while downloading "${url}" (status: ${result.status})`
        );
      }
      return base64ToText(result.bodyBase64);
    }
  );
};

type FileSet =
  | 'preview'
  | 'cordova'
  | 'electron'
  | 'web'
  | 'cocos2d-js'
  | 'facebook-instant-games';

const filesToDownload: { [FileSet]: Array<string> } = {
  preview: ['/Runtime/index.html'],
  web: ['/Runtime/index.html', '/Runtime/Electron/LICENSE.GDevelop.txt'],
  'cocos2d-js': [
    '/Runtime/Cocos2d/cocos2d-js-v3.10.js',
    '/Runtime/Cocos2d/index.html',
    '/Runtime/Cocos2d/main.js',
    '/Runtime/Cocos2d/project.json',
  ],
  'facebook-instant-games': [
    '/Runtime/FacebookInstantGames/fbapp-config.json',
    '/Runtime/FacebookInstantGames/index.html',
  ],
  cordova: [
    '/Runtime/Cordova/www/index.html',
    '/Runtime/Cordova/www/LICENSE.GDevelop.txt',
    '/Runtime/Cordova/config.xml',
    '/Runtime/Cordova/package.json',
  ],
  electron: [
    '/Runtime/index.html',
    '/Runtime/Electron/main.js',
    '/Runtime/Electron/package.json',
    '/Runtime/Electron/LICENSE.GDevelop.txt',
  ],
};

export type TextFileDescriptor = {| text: string, filePath: string |};

export const findGDJS = (
  fileSet: FileSet
): Promise<{|
  gdjsRoot: string,
  filesContent: Array<TextFileDescriptor>,
|}> => {
  // Get GDJS for this version. If you updated the version,
  // run `newIDE/web-app/scripts/deploy-GDJS-Runtime` script.
  let gdjsRoot = `https://resources.gdevelop-app.com/GDJS-${getIDEVersionWithHash()}`;

  if (Window.isDev()) {
    gdjsRoot =
      window.location.hostname === 'localhost'
        ? // Served by `watch-serve-GDJS-runtime.js` when running the IDE locally.
          `http://localhost:5002`
        : // On a deployed development build (e.g. editor-dev), use the runtime
          // bundled with the build (see `copy-GDJS-Runtime-to-build.js`).
          // Fetching localhost from a public origin would trigger the browser
          // "Local Network Access" permission prompt and fail for anyone
          // not running a local server.
          `${window.location.origin}/GDJS`;
  }

  return Promise.all(
    filesToDownload[fileSet].map(relativeFilePath => {
      const url = gdjsRoot + relativeFilePath;

      // Don't do any caching, rely on the browser cache only (outside Tauri;
      // the Tauri path has no browser cache to rely on regardless).
      return fetchText(url).then(text => ({
        filePath: url,
        text,
      }));
    })
  ).then(filesContent => {
    return {
      gdjsRoot,
      filesContent,
    };
  });
};
