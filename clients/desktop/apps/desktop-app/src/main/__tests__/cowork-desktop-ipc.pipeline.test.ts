/**
 * Cowork's renderer chat-send path, through the registered desktop IPC
 * handler, for the basic, acknowledged-steer, and Stop lifecycle rows.
 */
import { defineLifecycleScenarios } from './pipeline-harness/scenarios';

defineLifecycleScenarios('cowork', [1, 2, 13], {
  coworkDispatch: 'desktop-ipc',
});
