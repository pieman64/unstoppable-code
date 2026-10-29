/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import {
  buildSharedPipelineInfo,
  useSharedPipelineList,
} from '../useSharedPipelineList';
import type {
  PipelineInfo,
  PipelineShareOwner,
  SharedPipelineSummary,
} from '@canopy/desktop-shared/types/pipeline';
import {
  writeLastSharedAccountIdentity,
  writeSharedPipelineCache,
} from '@/lib/sharedPipelineCache';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

function makeSummary(
  overrides: Partial<SharedPipelineSummary> = {},
): SharedPipelineSummary {
  const base: SharedPipelineSummary = {
    id: 'remote-1',
    name: 'Test Pipeline',
    description: 'a description',
    icon: '✨',
    version: '3.0',
    triggerTypes: ['dispatch'],
    createdBy: { id: 'user-1', name: 'Alice' },
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
    canUpdate: true,
    canDelete: false,
  };
  return { ...base, ...overrides };
}

describe('buildSharedPipelineInfo', () => {
  it('maps a private summary to PipelineInfo with shareScope=private', () => {
    const summary = makeSummary({ shareScope: 'private' });
    const info = buildSharedPipelineInfo({ summary });

    expect(info.id).toBe(`shared:canopy-cloud:${summary.id}`);
    expect(info.source).toBe('shared');
    expect(info.shareScope).toBe('private');
    expect(info.owner).toBeUndefined();
  });

  it('maps a team summary, preserving team owner metadata unchanged', () => {
    const owner: PipelineShareOwner = {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: {
        id: 'org-1',
        name: 'Acme',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    };
    const summary = makeSummary({ shareScope: 'team', owner });
    const info = buildSharedPipelineInfo({ summary });

    expect(info.shareScope).toBe('team');
    expect(info.owner).toEqual(owner);
  });

  it('maps an organization summary, preserving organization owner metadata unchanged', () => {
    const owner: PipelineShareOwner = {
      type: 'organization',
      id: 'org-1',
      name: 'Acme',
    };
    const summary = makeSummary({ shareScope: 'organization', owner });
    const info = buildSharedPipelineInfo({ summary });

    expect(info.shareScope).toBe('organization');
    expect(info.owner).toEqual(owner);
  });

  it('falls back safely when shareScope and owner are missing (older server)', () => {
    const summary = makeSummary();
    // Sanity check: the test fixture intentionally omits both fields.
    expect(summary.shareScope).toBeUndefined();
    expect(summary.owner).toBeUndefined();

    const info = buildSharedPipelineInfo({ summary });

    expect(info.shareScope).toBe('private');
    expect(info.owner).toBeUndefined();
  });

  it('preserves canUpdate / canDelete and other identity fields', () => {
    const summary = makeSummary({
      canUpdate: false,
      canDelete: true,
      shareScope: 'private',
    });
    const info = buildSharedPipelineInfo({ summary });

    expect(info.canUpdate).toBe(false);
    expect(info.canDelete).toBe(true);
    expect(info.readonly).toBe(true);
    expect(info.serverId).toBe('canopy-cloud');
    expect(info.remoteId).toBe(summary.id);
  });

  it('preserves public share metadata', () => {
    const publicShare = {
      externalId: 'public-1',
      pinnedContentHash: 'sha256:abc',
      upToDate: true,
      sharePath: '/share/pipelines/public-1',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
    };

    expect(
      buildSharedPipelineInfo({ summary: makeSummary({ publicShare }) }),
    ).toEqual(expect.objectContaining({ publicShare }));
    expect(
      buildSharedPipelineInfo({ summary: makeSummary() }).publicShare,
    ).toBeNull();
  });
});

interface HookProbe {
  current: ReturnType<typeof useSharedPipelineList> | null;
}

function HookHarness({ probe }: { probe: HookProbe }): null {
  probe.current = useSharedPipelineList();
  return null;
}

function makePipelineInfo(overrides: Partial<PipelineInfo> = {}): PipelineInfo {
  return {
    id: 'shared:canopy-cloud:remote-1',
    name: 'Cached Pipeline',
    filename: '',
    description: '',
    icon: '',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
    triggerTypes: ['dispatch'],
    source: 'shared',
    readonly: false,
    serverId: 'canopy-cloud',
    remoteId: 'remote-1',
    ...overrides,
  };
}

describe('useSharedPipelineList cache seeding', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'] | undefined;

  beforeEach(() => {
    originalApi = window.api;
    localStorage.clear();
    // Organization projects default on when LaunchDarkly is not configured;
    // these cases cover the legacy (context-free) cache keys.
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = false;
    useFeatureFlagsStore.setState({ snapshot });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('waits to show cached rows until the active account identity is verified', async () => {
    const identity = 'acct-1:2026-06-18T00:00:00.000Z:pipelines-crud-v1';
    writeLastSharedAccountIdentity(identity);
    writeSharedPipelineCache(`${identity}::all`, {
      rows: [makePipelineInfo()],
      nextCursor: null,
    });

    let resolveAccount: (value: CanopyCloudAccountPublicState) => void = () =>
      undefined;
    const accountPromise = new Promise<CanopyCloudAccountPublicState>(
      (resolve) => {
        resolveAccount = resolve;
      },
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest.fn(() => accountPromise),
      },
    });

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(createElement(HookHarness, { probe }));
      await Promise.resolve();
    });

    expect(probe.current?.cloudLoading).toBe(true);
    expect(probe.current?.rows).toEqual([]);

    resolveAccount({
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['pipelines-crud-v1'],
      account: {
        id: 'acct-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
      updatedAt: '2026-06-18T00:00:00.000Z',
      storageAvailable: true,
    });
    await act(async () => {
      await accountPromise;
      await Promise.resolve();
    });

    expect(probe.current?.cloudLoading).toBe(false);
    expect(probe.current?.rows.map((row) => row.name)).toEqual([
      'Cached Pipeline',
    ]);
  });
});
