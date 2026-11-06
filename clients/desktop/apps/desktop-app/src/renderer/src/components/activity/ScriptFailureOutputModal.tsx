import type { JSX } from 'react';
import { ScriptOutputModal } from '@canopy/ui-app';
import {
  closeScriptFailureOutput,
  useScriptFailureOutputStore,
} from '@/stores/scriptFailureOutputStore';

/**
 * The output modal behind a failure toast's View output. Mounted once at the
 * app root, since the run's worktree may not be open or its Activity panel
 * never loaded.
 */
export function ScriptFailureOutputModal(): JSX.Element | null {
  const run = useScriptFailureOutputStore((state) => state.run);
  if (run === null) return null;
  return <ScriptOutputModal run={run} onClose={closeScriptFailureOutput} />;
}
