/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import { RepoRulesStatusCard } from '../RepoRulesStatusCard';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function fakeClient(
  status: RepoRulesStatus,
  repoRulesImport = true,
): { client: CanopyClient; query: jest.Mock; command: jest.Mock } {
  const query = jest.fn(() => Promise.resolve(status));
  const command = jest.fn(() =>
    Promise.resolve({
      ...status,
      enabled: false,
      revision: status.revision + 1,
    }),
  );
  return {
    query,
    command,
    client: {
      capabilities: {
        localExecution: true,
        terminalPty: true,
        fileSystemAccess: 'read-write',
        voice: false,
        settingsScope: 'api-keys-only',
        pipelines: 'crud-only',
        routing: 'url',
        ...(repoRulesImport ? { repoRulesImport: true } : {}),
      },
      query,
      command,
      subscribe: () => () => undefined,
    },
  };
}

async function render(
  client: CanopyClient,
  onReview = jest.fn(),
): Promise<void> {
  await act(async () => {
    root.render(
      <CanopyClientProvider client={client}>
        <RepoRulesStatusCard workspaceId="ws-1" onReview={onReview} />
      </CanopyClientProvider>,
    );
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('RepoRulesStatusCard', () => {
  it('shows the saved policy without scanning and turns rules off directly', async () => {
    const { client, query, command } = fakeClient({
      enabled: true,
      disabledRuleIds: ['a', 'b'],
      revision: 2,
    });
    await render(client);
    expect(query.mock.calls).toEqual([
      ['repoRules.status', { workspaceId: 'ws-1' }],
    ]);
    expect(
      byTestId('project-settings-repo-rules-status')?.textContent,
    ).toContain('except 2 turned off');
    await act(async () => {
      byTestId('project-settings-repo-rules-turn-off')?.click();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(command).toHaveBeenCalledWith('repoRules.apply', {
      workspaceId: 'ws-1',
      enabled: false,
    });
    expect(byTestId('project-settings-repo-rules-status')?.textContent).toMatch(
      /^Off\./,
    );
    expect(byTestId('project-settings-repo-rules-turn-off')).toBeNull();
  });

  it('opens the review for this workspace', async () => {
    const onReview = jest.fn();
    const { client } = fakeClient({
      enabled: false,
      disabledRuleIds: [],
      revision: 0,
    });
    await render(client, onReview);
    act(() => byTestId('project-settings-repo-rules-review')?.click());
    expect(onReview).toHaveBeenCalled();
  });

  it('renders nothing without the capability', async () => {
    const { client, query } = fakeClient(
      { enabled: true, disabledRuleIds: [], revision: 1 },
      false,
    );
    await render(client);
    expect(container.textContent).toBe('');
    expect(query).not.toHaveBeenCalled();
  });
});
