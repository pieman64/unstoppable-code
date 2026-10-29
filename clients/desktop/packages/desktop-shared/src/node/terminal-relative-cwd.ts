import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isScriptActionRelativePath } from '@canopy/protocol/script-actions';

/** Resolve only beneath a host-authorized base; never accept an absolute override. */
export function resolveTerminalRelativeCwd(
  base: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isScriptActionRelativePath(value))
    throw new Error('Invalid relative terminal directory.');
  const root = realpathSync(base);
  const target = realpathSync(resolve(root, value));
  const remainder = relative(root, target);
  if (
    remainder === '..' ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder) ||
    !statSync(target).isDirectory()
  ) {
    throw new Error(
      'Terminal directory must be inside the selected repository.',
    );
  }
  return target;
}
