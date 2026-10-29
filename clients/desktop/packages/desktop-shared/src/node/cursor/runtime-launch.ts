import { join } from 'node:path';
import type { CursorRuntimeTarget } from '../../lib/cursor-runtime-targets';

export interface CursorLaunch {
  readonly command: string;
  readonly prefix: readonly string[];
}

/** Launcher argv for an installed pinned version; does not check the files. */
export function resolveCursorLaunch(
  root: string,
  version: string,
  target: CursorRuntimeTarget,
): CursorLaunch {
  if (!/^[a-zA-Z0-9.-]+$/.test(version))
    throw new Error('Invalid Cursor runtime version.');
  const [command, ...prefix] = target.launch.map((name) =>
    join(root, version, name),
  );
  if (!command) throw new Error('Cursor runtime target has no launcher.');
  return { command, prefix };
}
