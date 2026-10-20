// @flow
import {
  type EventsFunctionCodeWriter,
  type EventsFunctionCodeWriterCallbacks,
} from '..';
import { makeTimestampedId } from '../../Utils/TimestampedId';
import slugs from 'slugs';
// TauriBridge does not exist yet in this worktree (B1's deliverable, see
// ADR-001-tauri-mvp.md §2.4 and §3, and TauriBridge-contract.md §4). This
// import is correct per the contract and will resolve once Gate 1 merges
// B1. Per the Wave-1 lint rule (contract §6), only TauriBridge.js may
// import `@tauri-apps/*` or call `optionalRequire` for platform access:
// every other Tauri file, including this one, goes through it instead -
// generated code is written with `TauriBridge.writeTextFile`, never a raw
// `fs` call.
import TauriBridge, {
  type TauriBridgeEnv,
} from '../../Utils/Tauri/TauriBridge';

/**
 * Create the EventsFunctionCodeWriter that writes generated code for events
 * functions to local files, through TauriBridge.
 *
 * This mirrors `makeLocalEventsFunctionCodeWriter`: the generated code is
 * written under the app's cache directory rather than the OS temp directory
 * (Tauri has no bundled Node `os.tmpdir()`; `env.appCacheDir` is the
 * equivalent well-known dir, resolved once by `TauriBridge.init()`), but
 * both are meant to survive for the life of the preview and be referenced
 * by an absolute path that the preview export copies in
 * (`getIncludeFileFor`).
 *
 * Unlike the Browser code writers (SW-based: stored to IndexedDB, only
 * readable by a service worker; S3-based: uploaded to the cloud), this one
 * fits a local, offline preview - see ADR-001-tauri-mvp.md §2.4. Neither
 * Browser writer's include paths (an IndexedDB key, an S3 URL) are usable
 * from a local preview window with no IPC capabilities.
 */
export const makeTauriEventsFunctionCodeWriter = ({
  env,
  onWriteFile,
}: {|
  ...EventsFunctionCodeWriterCallbacks,
  /** The resolved value of `TauriBridge.init()` - see TauriPreviewLauncher. */
  env: TauriBridgeEnv,
|}): EventsFunctionCodeWriter => {
  // The generated code for extensions is stored in a dedicated subfolder of
  // the app's cache directory, unique to this editor session, so multiple
  // GDevelop windows/tabs never clash.
  const outputDir = `${env.appCacheDir}${
    env.pathSeparator
  }GDGeneratedEventsFunctions-${makeTimestampedId()}`;

  // `getIncludeFileFor` (below) must stay synchronous: it's called a lot,
  // including during render, exactly like `ResourcesLoader.getFullUrl`
  // (TauriBridge-contract.md §5). This is still fine without a bridge-sync
  // exception, because building this path is pure string concatenation
  // against `env` (already resolved once by `init()`) - no IPC call is
  // made here, unlike `getResourceUrlSync`.
  const getPathFor = (codeNamespace: string): string =>
    `${outputDir}${env.pathSeparator}${slugs(codeNamespace)}.js`;

  const writeCode = (codeNamespace: string, code: string): Promise<void> => {
    const includeFile = getPathFor(codeNamespace);
    onWriteFile({ includeFile, content: code });
    return TauriBridge.writeTextFile(includeFile, code);
  };

  return {
    getIncludeFileFor: (codeNamespace: string) => getPathFor(codeNamespace),
    writeFunctionCode: (functionCodeNamespace: string, code: string) =>
      writeCode(functionCodeNamespace, code),
    writeBehaviorCode: (behaviorCodeNamespace: string, code: string) =>
      writeCode(behaviorCodeNamespace, code),
    writeObjectCode: (objectCodeNamespace: string, code: string) =>
      writeCode(objectCodeNamespace, code),
  };
};
