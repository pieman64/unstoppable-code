import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { createDesktopCapabilities } from '@/client/ipc-canopy-client';
import { resolveComposerWorkflowGates } from '../composer-workflow-gates';

const capabilities = createDesktopCapabilities('darwin');

function gates(
  providerType: string | undefined,
  overrides: {
    interfaceMode?: string;
    projectId?: string;
    capabilities?: typeof capabilities;
  } = {},
): ReturnType<typeof resolveComposerWorkflowGates> {
  return resolveComposerWorkflowGates({
    providerType,
    interfaceMode: overrides.interfaceMode ?? 'canopy',
    projectId: 'projectId' in overrides ? overrides.projectId : 'project',
    capabilities: overrides.capabilities ?? capabilities,
  });
}

test('keeps Cursor scheduling unavailable while enabling plan review', () => {
  for (const projectId of ['project', APP_ADVISOR_PROJECT_ID]) {
    expect(gates('cursor', { projectId })).toEqual({
      scheduledSends: false,
      planModeReadOnly: false,
    });
  }
});

test('keeps Copilot on read-only plan mode without scheduling', () => {
  for (const providerType of ['copilot']) {
    expect(gates(providerType)).toEqual({
      scheduledSends: false,
      planModeReadOnly: true,
    });
  }
});

test('preserves Claude and Codex behavior, including without a target', () => {
  for (const providerType of ['claude', 'codex', undefined]) {
    expect(gates(providerType)).toEqual({
      scheduledSends: true,
      planModeReadOnly: false,
    });
    expect(gates(providerType, { projectId: undefined })).toEqual({
      scheduledSends: true,
      planModeReadOnly: false,
    });
    expect(gates(providerType, { interfaceMode: 'claude-code' })).toEqual({
      scheduledSends: false,
      planModeReadOnly: false,
    });
  }
});

test('fails closed for Cursor without host support or a resolved target', () => {
  expect(gates('cursor', { projectId: undefined })).toEqual({
    scheduledSends: false,
    planModeReadOnly: true,
  });
  expect(gates('cursor', { interfaceMode: 'claude-code' })).toEqual({
    scheduledSends: false,
    planModeReadOnly: true,
  });
  expect(
    gates('cursor', {
      capabilities: {
        ...capabilities,
        automations: false,
        chatWorkflows: { planMode: true },
      },
    }),
  ).toEqual({ scheduledSends: false, planModeReadOnly: true });
});

test('preserves OpenCode scheduling through the shared workflow gate', () => {
  expect(gates('opencode')).toEqual({
    scheduledSends: true,
    planModeReadOnly: false,
  });
});
