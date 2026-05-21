import { dirname, join } from 'node:path';
import type * as types from '../_types';
import type { ThreadRecord } from '../_types';

//
// Environment
//

function cleanBaseEnv(baseEnv: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(baseEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

export const threadTerminalEnv: typeof types.threadTerminalEnv = (
  thread: ThreadRecord,
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string> => ({
  ...cleanBaseEnv(baseEnv),
  THREAD_ID: thread.id,
  THREAD_TITLE: thread.title,
  THREAD_FILE: thread.filePath,
  THREADS_DIR: dirname(thread.filePath),
  THREADS_PROTOCOL_PATH: join(process.cwd(), 'threads-protocol.md'),
});
