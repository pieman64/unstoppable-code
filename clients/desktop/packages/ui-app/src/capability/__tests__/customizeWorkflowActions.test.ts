import type { CanopyCapabilities } from '@canopy/app-core';
import {
  BUILT_IN_WORKFLOW_STATUS_REASON,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  WORKFLOW_MANAGE_UNAVAILABLE_REASON,
  WORKFLOW_RUN_UNAVAILABLE_HERE,
} from '../../workflows/workflow-library-model';
import {
  customizeWorkflowAvailability,
  type CustomizeWorkflowActions,
} from '../customizeWorkflowActions';

const DESKTOP: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: true,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
  automations: true,
  workflowManagement: true,
};

// The portal relays runs to the paired desktop but cannot manage workflows.
const WEB: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'execute',
  routing: 'url',
  overviewNotifications: false,
};

function base(overrides: Partial<UnifiedPluginEntry>): UnifiedPluginEntry {
  return {
    id: 'skill:local:alpha',
    kind: 'skill',
    origin: 'installed-standalone',
    name: 'Alpha',
    description: '',
    categories: [],
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'installed',
    recommended: false,
    ref: { type: 'skill', sourceId: 'local', skillName: 'alpha' },
    ...overrides,
  };
}

function pipeline(
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return base({
    id: 'pipeline:user:nightly',
    kind: 'pipeline',
    name: 'Nightly build',
    workflow: { triggerText: 'Manual', runnable: true },
    ref: { type: 'pipeline', pipelineId: 'nightly', source: 'user' },
    ...overrides,
  });
}

function automation(): UnifiedPluginEntry {
  return base({
    id: 'automation:local:standup',
    kind: 'automation',
    name: 'Morning standup',
    workflow: { triggerText: 'Every day at 09:00', enabled: true },
    ref: { type: 'automation', activityId: 'standup' },
  });
}

const noop = (): Promise<void> => Promise.resolve();

function actions(
  overrides: Partial<CustomizeWorkflowActions> = {},
): CustomizeWorkflowActions {
  return {
    capabilities: DESKTOP,
    onRun: noop,
    onSetEnabled: noop,
    onRunNow: noop,
    onEdit: (): void => undefined,
    onViewRuns: (): void => undefined,
    onDelete: () => Promise.resolve(null),
    ...overrides,
  };
}

const AVAILABLE = { available: true };

describe('customizeWorkflowAvailability', () => {
  it('offers every applicable action on a host with full capabilities', () => {
    expect(customizeWorkflowAvailability(pipeline(), actions())).toEqual({
      run: AVAILABLE,
      toggle: {
        available: false,
        reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON,
      },
      runNow: {
        available: false,
        reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON,
      },
      edit: AVAILABLE,
      viewRuns: AVAILABLE,
      delete: AVAILABLE,
    });
    expect(customizeWorkflowAvailability(automation(), actions())).toEqual({
      run: { available: false, reason: WORKFLOW_RUN_UNAVAILABLE_HERE },
      toggle: AVAILABLE,
      runNow: AVAILABLE,
      edit: AVAILABLE,
      viewRuns: AVAILABLE,
      delete: AVAILABLE,
    });
  });

  it('names the trigger when a pipeline cannot be started by hand', () => {
    const entry = pipeline({
      workflow: {
        triggerText: 'When a plan is approved',
        runnable: false,
        runUnavailableLabel: 'Starts from an approved plan',
      },
    });
    expect(customizeWorkflowAvailability(entry, actions()).run).toEqual({
      available: false,
      reason: 'Starts from an approved plan',
    });
  });

  it('gates management on a portal-shaped host while Run stays available', () => {
    const availability = customizeWorkflowAvailability(pipeline(), {
      capabilities: WEB,
      onRun: noop,
    });
    expect(availability.run).toEqual(AVAILABLE);
    for (const state of [
      availability.edit,
      availability.viewRuns,
      availability.delete,
    ]) {
      expect(state).toEqual({
        available: false,
        reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON,
      });
    }
    const automationAvailability = customizeWorkflowAvailability(automation(), {
      capabilities: WEB,
    });
    expect(automationAvailability.toggle.available).toBe(false);
    expect(automationAvailability.runNow.available).toBe(false);
  });

  it('cannot run without a host callback', () => {
    expect(
      customizeWorkflowAvailability(pipeline(), actions({ onRun: undefined }))
        .run,
    ).toEqual({ available: false, reason: WORKFLOW_RUN_UNAVAILABLE_HERE });
  });

  it('never deletes a built-in pipeline but still edits it', () => {
    const bundled = pipeline({
      ref: { type: 'pipeline', pipelineId: 'nightly', source: 'bundled' },
    });
    const availability = customizeWorkflowAvailability(bundled, actions());
    expect(availability.delete).toEqual({
      available: false,
      reason: BUILT_IN_WORKFLOW_STATUS_REASON,
    });
    expect(availability.edit).toEqual(AVAILABLE);
  });

  it('never deletes a readonly project pipeline but still offers Edit like the Library', () => {
    const entry = pipeline({
      workflow: { runnable: true, readonly: true },
      ref: { type: 'pipeline', pipelineId: 'nightly', source: 'project' },
    });
    const availability = customizeWorkflowAvailability(entry, actions());
    expect(availability.delete.available).toBe(false);
    expect(availability.edit).toEqual(AVAILABLE);
    expect(availability.run).toEqual(AVAILABLE);
  });

  it('offers nothing on a non-workflow entry', () => {
    const availability = customizeWorkflowAvailability(base({}), actions());
    const states = [
      availability.run,
      availability.toggle,
      availability.runNow,
      availability.edit,
      availability.viewRuns,
      availability.delete,
    ];
    expect(states.every((state) => !state.available)).toBe(true);
  });
});
