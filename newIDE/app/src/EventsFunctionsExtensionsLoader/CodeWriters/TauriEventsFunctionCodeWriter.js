// @flow
import {
  type EventsFunctionCodeWriter,
  type EventsFunctionCodeWriterCallbacks,
} from '..';
import { makeTimestampedId } from '../../Utils/TimestampedId';
import slugs from 'slugs';
import TauriBridge, {
  type TauriBridgeEnv,
} from '../../Utils/Tauri/TauriBridge';

/**
 * Create the EventsFunctionCodeWriter that writes generated code for events
 * functions to local files, through TauriBridge.
 */
export const makeTauriEventsFunctionCodeWriter = ({
  env,
  onWriteFile,
}: {|
  ...EventsFunctionCodeWriterCallbacks,
  env: TauriBridgeEnv,
|}): EventsFunctionCodeWriter => {
  // Unique per session so multiple editor windows don't clash.
  const outputDir = `${env.appCacheDir}${
    env.pathSeparator
  }GDGeneratedEventsFunctions-${makeTimestampedId()}`;

  // Pure string concatenation, no IPC - safe to stay synchronous.
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
