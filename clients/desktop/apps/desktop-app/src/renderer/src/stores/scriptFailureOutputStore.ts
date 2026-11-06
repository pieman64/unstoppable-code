import { create } from 'zustand';
import type { ScriptOutputModalProps } from '@canopy/ui-app';

export type FailedScriptRun = ScriptOutputModalProps['run'];

/** The failed run whose output a toast's View output opened, if any. */
export const useScriptFailureOutputStore = create<{
  run: FailedScriptRun | null;
}>(() => ({ run: null }));

export function openScriptFailureOutput(run: FailedScriptRun): void {
  useScriptFailureOutputStore.setState({ run });
}

export function closeScriptFailureOutput(): void {
  useScriptFailureOutputStore.setState({ run: null });
}
