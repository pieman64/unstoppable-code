/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type {
  PortalPlanDetail,
  PortalPlanGetPayload,
} from '@canopy/protocol/portal';
import type { PlanCopyState } from '@canopy/ui-shared/components';
import { usePinnedPlanCopy, type PinnedPlanTarget } from '../usePinnedPlanCopy';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
};

interface PendingRead {
  readonly args: PortalPlanGetPayload;
  resolve(plan: PortalPlanDetail): void;
  reject(error: Error): void;
}

function createClient(): CanopyClient & { readonly reads: PendingRead[] } {
  const reads: PendingRead[] = [];
  return {
    reads,
    capabilities: CAPABILITIES,
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      if (name !== 'plan.get') {
        return Promise.reject(new Error(`unexpected query ${name}`));
      }
      // The fake only answers the one query it is built for.
      return new Promise<PortalPlanDetail>((resolve, reject) => {
        reads.push({ args: args as PortalPlanGetPayload, resolve, reject });
      });
    },
    command<K extends CommandName>(name: K): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error(`unexpected command ${name}`));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

function detail(revisionNumber: number, content: string): PortalPlanDetail {
  return {
    workspaceLocalId: 'p1',
    worktreeLocalId: 'w1',
    planId: 'plan-1',
    title: 'Plan',
    status: 'pending',
    content,
    body: content,
    revisionNumber,
    latestRevisionNumber: 3,
  };
}

const target = (revisionNumber: number): PinnedPlanTarget => ({
  projectId: 'p1',
  worktreeId: 'w1',
  planId: 'plan-1',
  revisionNumber,
});

describe('usePinnedPlanCopy (CAN-5354)', () => {
  let container: HTMLElement;
  let root: Root;
  let seen: (PlanCopyState | undefined)[];

  function Probe({ pinned }: { pinned: PinnedPlanTarget | null }): JSX.Element {
    seen.push(usePinnedPlanCopy(pinned));
    return <span />;
  }

  function render(client: CanopyClient, pinned: PinnedPlanTarget | null): void {
    act(() =>
      root.render(
        <CanopyClientProvider client={client}>
          <Probe pinned={pinned} />
        </CanopyClientProvider>,
      ),
    );
  }

  const latest = (): PlanCopyState | undefined => seen[seen.length - 1];

  beforeEach(() => {
    seen = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reads the pinned revision and copies its full Markdown', async () => {
    const client = createClient();
    const long = `# Plan\n\n${'- step ✓\n'.repeat(800)}`;
    render(client, target(2));
    expect(latest()).toEqual({ status: 'loading' });
    expect(client.reads[0]?.args).toEqual({
      projectId: 'p1',
      worktreeId: 'w1',
      planId: 'plan-1',
      revisionNumber: 2,
    });
    await act(async () => {
      client.reads[0]?.resolve(detail(2, long));
      await Promise.resolve();
    });
    expect(latest()).toEqual({ status: 'ready', markdown: long });
  });

  it('never copies a different revision or a failed read', async () => {
    const client = createClient();
    render(client, target(2));
    await act(async () => {
      client.reads[0]?.resolve(detail(3, '# Latest'));
      await Promise.resolve();
    });
    expect(latest()).toMatchObject({ status: 'unavailable' });

    render(client, target(1));
    await act(async () => {
      client.reads[1]?.reject(new Error('404'));
      await Promise.resolve();
    });
    expect(latest()).toMatchObject({ status: 'unavailable' });
  });

  it('discards a late result for a superseded proposal', async () => {
    const client = createClient();
    render(client, target(1));
    render(client, target(2));
    expect(latest()).toEqual({ status: 'loading' });
    await act(async () => {
      client.reads[0]?.resolve(detail(1, '# Old'));
      await Promise.resolve();
    });
    expect(latest()).toEqual({ status: 'loading' });
    await act(async () => {
      client.reads[1]?.resolve(detail(2, '# New'));
      await Promise.resolve();
    });
    expect(latest()).toEqual({ status: 'ready', markdown: '# New' });
  });

  it('offers nothing without a pinned proposal', () => {
    const client = createClient();
    render(client, null);
    expect(latest()).toBeUndefined();
    expect(client.reads).toHaveLength(0);
  });

  it.each(['workspaceLocalId', 'worktreeLocalId'] as const)(
    'rejects another scope even when plan id and revision match (%s)',
    async (field) => {
      const client = createClient();
      render(client, target(1));
      await act(async () => {
        client.reads[0]?.resolve({
          ...detail(1, '# Wrong scope'),
          [field]: 'other',
        });
        await Promise.resolve();
      });
      expect(latest()).toMatchObject({ status: 'unavailable' });
    },
  );

  it('invalidates loaded content when the host client is replaced', async () => {
    const first = createClient();
    render(first, target(1));
    await act(async () => {
      first.reads[0]?.resolve(detail(1, '# Old account'));
      await Promise.resolve();
    });
    expect(latest()).toEqual({ status: 'ready', markdown: '# Old account' });
    render(createClient(), target(1));
    expect(latest()).toEqual({ status: 'loading' });
  });
});
