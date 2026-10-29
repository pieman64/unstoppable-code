import { capabilityInstructionIdentity } from '@canopy/desktop-shared/node/capabilities/file-snapshot';
import { openCodeCapabilityFiles } from '@canopy/desktop-shared/node/opencode/capability-snapshot';
import type { DelegationNativePolicy } from './native-policy';

/** Only host-declared private copies may exchange a path for a content identity. */
export async function openCodeDelegationPolicyIdentity(
  tools: DelegationNativePolicy,
  retainedRoots: readonly string[],
  signal: AbortSignal,
): Promise<unknown> {
  const roots = Array.from(new Set(retainedRoots));
  if (roots.some((root) => !root || !tools.readRoots.includes(root)))
    throw new Error('Retained capability files require a read grant.');
  const files = await openCodeCapabilityFiles(roots, signal);
  signal.throwIfAborted();
  const instructions = capabilityInstructionIdentity(
    tools.instructions(),
    roots,
  );
  return {
    cwd: tools.cwd,
    mode: tools.mode,
    writable: tools.writable(),
    writePaths: tools.writePaths,
    readRoots: tools.readRoots.map((root) => {
      const index = roots.indexOf(root);
      return index < 0 ? { path: root } : { retainedRoot: index };
    }),
    files,
    instructions,
  };
}
