import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { getCursorRuntimeRootDir } from '../../pipelines/config-paths';
import {
  CURSOR_RUNTIME_VERSION,
  getCursorRuntimeTargetForHost,
} from './runtime-metadata';

export interface CursorRuntimeInstallState {
  supported: boolean;
  installed: boolean;
  version: string;
}

/** Cheap file presence check: no hashing, no process, no preferences. */
export async function cursorRuntimeInstalled(
  options: {
    root?: string;
    platform?: string;
    arch?: string;
  } = {},
): Promise<CursorRuntimeInstallState> {
  const target = getCursorRuntimeTargetForHost(options.platform, options.arch);
  const root = options.root ?? getCursorRuntimeRootDir();
  if (!target)
    return {
      supported: false,
      installed: false,
      version: CURSOR_RUNTIME_VERSION,
    };
  try {
    for (const name of target.required) {
      const launcher = join(root, CURSOR_RUNTIME_VERSION, name);
      const entry = await lstat(launcher);
      if (!entry.isFile() || entry.isSymbolicLink())
        return {
          supported: true,
          installed: false,
          version: CURSOR_RUNTIME_VERSION,
        };
      if (target.executables.includes(name))
        await access(launcher, constants.X_OK);
    }
    return {
      supported: true,
      installed: true,
      version: CURSOR_RUNTIME_VERSION,
    };
  } catch {
    return {
      supported: true,
      installed: false,
      version: CURSOR_RUNTIME_VERSION,
    };
  }
}
