import type { CodeGraphBuildPhase } from '../build-timings';
import type { ResolutionCaptureResolver } from './resolution-dependency-capture';
/** Measurements only; never consulted for capture/scheduling policy. */
export const RESOLUTION_CAPTURE_PHASES: Readonly<
  Record<ResolutionCaptureResolver, CodeGraphBuildPhase>
> = {
  'ts-module-resolution': 'importsMs',
  'config-extends': 'configExtendsMs',
  'doc-link': 'docLinksMs',
  'ipc-channel': 'ipcMs',
  'workflow-action': 'workflowActionsMs',
  'call-resolution': 'callsMs',
  'test-linker': 'testsMs',
};
