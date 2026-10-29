/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { ImportedCursorRulesOffer } from '../ImportedCursorRulesOffer';

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

function client(
  presence: (workspaceId: string) => Promise<{ cursorRulesPresent: boolean }>,
  repoRulesImport = true,
): { client: CanopyClient; query: jest.Mock } {
  const query = jest.fn((_name: string, args: { workspaceId: string }) =>
    presence(args.workspaceId),
  );
  return {
    query,
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
      command: jest.fn(),
      subscribe: () => () => undefined,
    },
  };
}

async function render(
  canopyClient: CanopyClient,
  onReview: (workspaceId: string) => void = jest.fn(),
): Promise<void> {
  await act(async () => {
    root.render(
      <CanopyClientProvider client={canopyClient}>
        <ImportedCursorRulesOffer
          workspaces={[
            { workspaceId: 'ws-a', displayName: 'Alpha' },
            { workspaceId: 'ws-b', displayName: 'Beta' },
            { workspaceId: 'ws-c', displayName: 'Gamma' },
          ]}
          onReview={onReview}
        />
      </CanopyClientProvider>,
    );
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

describe('ImportedCursorRulesOffer', () => {
  it('offers review only for workspaces with a positive hint, by explicit id', async () => {
    const onReview = jest.fn();
    const { client: canopyClient, query } = client((workspaceId) =>
      workspaceId === 'ws-a'
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve({ cursorRulesPresent: workspaceId === 'ws-b' }),
    );
    await render(canopyClient, onReview);

    expect(query).toHaveBeenCalledWith('editorSetup.presence', {
      workspaceId: 'ws-a',
    });
    const offer = container.querySelector(
      '[data-testid="import-projects-cursor-rules"]',
    );
    expect(offer?.textContent).toContain('Beta');
    expect(offer?.textContent).not.toContain('Alpha');
    expect(offer?.textContent).not.toContain('Gamma');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="import-projects-cursor-rules-review-ws-b"]',
    );
    act(() => button?.click());
    expect(onReview).toHaveBeenCalledWith('ws-b');
  });

  it('renders nothing and makes no calls without the capability', async () => {
    const { client: canopyClient, query } = client(
      () => Promise.resolve({ cursorRulesPresent: true }),
      false,
    );
    await render(canopyClient);
    expect(query).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});
