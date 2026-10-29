import type {
  WorkspaceContextBroadcast,
  WorkspaceContextState,
} from '@canopy/desktop-shared/types';

const mockGet = jest.fn<Promise<WorkspaceContextState>, []>();
const mockSet = jest.fn<Promise<WorkspaceContextState>, [unknown]>();

jest.mock('../../lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

import {
  useWorkspaceContext,
  useWorkspaceContextStore,
} from '../workspaceContextStore';

const ORG_A = '11111111-1111-4111-8111-111111111111';

function reset(): void {
  useWorkspaceContextStore.setState({
    state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
    hydrated: false,
    lastChangeReason: null,
    accountEpoch: 0,
    appliedGeneration: 0,
  });
}

describe('workspaceContextStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reset();
    Object.defineProperty(globalThis, 'window', {
      value: { api: { workspaceContext: { get: mockGet, set: mockSet } } },
      configurable: true,
      writable: true,
    });
  });

  it('hydrates from main and exposes the context', async () => {
    mockGet.mockResolvedValue({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 2,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    });

    await useWorkspaceContextStore.getState().hydrate();

    expect(useWorkspaceContextStore.getState().hydrated).toBe(true);
    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'organization',
      organizationId: ORG_A,
    });
  });

  it('keeps Personal when hydration fails', async () => {
    mockGet.mockRejectedValue(new Error('ipc down'));

    await useWorkspaceContextStore.getState().hydrate();

    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'personal',
    });
    expect(useWorkspaceContextStore.getState().hydrated).toBe(false);
  });

  it('applies broadcasts in revision order and records the reason', () => {
    const newer: WorkspaceContextBroadcast = {
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 5,
      organizations: [],
      reason: 'switch',
    };
    const stale: WorkspaceContextBroadcast = {
      context: { kind: 'personal' },
      revision: 3,
      organizations: [],
      reason: 'switch',
    };

    useWorkspaceContextStore.getState().applyBroadcast(newer);
    useWorkspaceContextStore.getState().applyBroadcast(stale);

    expect(useWorkspaceContextStore.getState().state.revision).toBe(5);
    expect(useWorkspaceContextStore.getState().lastChangeReason).toBe('switch');
  });

  it('accepts a lower revision on an account change', () => {
    useWorkspaceContextStore.getState().applyBroadcast({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 5,
      organizations: [],
      reason: 'switch',
    });

    useWorkspaceContextStore.getState().applyBroadcast({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
      reason: 'account-change',
    });

    expect(useWorkspaceContextStore.getState().state).toEqual({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    });
    expect(useWorkspaceContextStore.getState().lastChangeReason).toBe(
      'account-change',
    );
  });

  it('sends the observed revision with a switch and adopts the reply', async () => {
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 4, organizations: [] },
    });
    mockSet.mockResolvedValue({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 5,
      organizations: [],
    });

    await useWorkspaceContextStore
      .getState()
      .setContext({ kind: 'organization', organizationId: ORG_A });

    expect(mockSet).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: ORG_A },
      expectedRevision: 4,
    });
    expect(useWorkspaceContextStore.getState().state.revision).toBe(5);
  });

  it('leaves local state untouched when main rejects the switch', async () => {
    mockSet.mockRejectedValue(new Error('stale-revision'));

    await expect(
      useWorkspaceContextStore
        .getState()
        .setContext({ kind: 'organization', organizationId: ORG_A }),
    ).rejects.toThrow('stale-revision');

    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'personal',
    });
  });

  it('exposes the selector hook', () => {
    expect(typeof useWorkspaceContext).toBe('function');
  });
});

describe('late IPC replies', () => {
  beforeEach(reset);

  it('drops a hydration reply that is older than a broadcast applied meanwhile', async () => {
    let resolveGet: (state: WorkspaceContextState) => void = () => {};
    mockGet.mockReturnValue(
      new Promise<WorkspaceContextState>((resolve) => {
        resolveGet = resolve;
      }),
    );
    const pending = useWorkspaceContextStore.getState().hydrate();
    useWorkspaceContextStore.getState().applyBroadcast({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 5,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      reason: 'switch',
    });
    resolveGet({
      context: { kind: 'personal' },
      revision: 4,
      organizations: [],
    });
    await pending;
    expect(useWorkspaceContextStore.getState().state.revision).toBe(5);
    expect(useWorkspaceContextStore.getState().hydrated).toBe(true);
  });

  it('keeps a membership-only broadcast over a same-revision hydration reply', async (): Promise<void> => {
    let resolveGet: (state: WorkspaceContextState) => void = (): void => {};
    mockGet.mockReturnValue(
      new Promise<WorkspaceContextState>((resolve): void => {
        resolveGet = resolve;
      }),
    );
    const pending = useWorkspaceContextStore.getState().hydrate();
    const newer: WorkspaceContextState = {
      context: { kind: 'personal' },
      revision: 0,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    };
    useWorkspaceContextStore.getState().applyBroadcast({
      ...newer,
      reason: 'organizations',
    });
    resolveGet({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    });

    await pending;

    expect(useWorkspaceContextStore.getState().state).toEqual(newer);
  });

  it('resolves a switch whose requested context a same-revision membership broadcast already carries, keeping the broadcast', async (): Promise<void> => {
    let resolveSet: (state: WorkspaceContextState) => void = (): void => {};
    mockSet.mockReturnValue(
      new Promise<WorkspaceContextState>((resolve): void => {
        resolveSet = resolve;
      }),
    );
    const pending = useWorkspaceContextStore
      .getState()
      .setContext({ kind: 'organization', organizationId: ORG_A });
    const newer: WorkspaceContextState = {
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 1,
      organizations: [{ id: ORG_A, name: 'Updated Acme', role: 'MEMBER' }],
    };
    useWorkspaceContextStore.getState().applyBroadcast({
      ...newer,
      reason: 'organizations',
    });
    resolveSet({ ...newer, organizations: [] });

    await expect(pending).resolves.toEqual(newer);
    expect(useWorkspaceContextStore.getState().state).toEqual(newer);
  });

  it('resolves a switch whose own broadcast landed before the reply', async (): Promise<void> => {
    let resolveSet: (state: WorkspaceContextState) => void = (): void => {};
    mockSet.mockReturnValue(
      new Promise<WorkspaceContextState>((resolve): void => {
        resolveSet = resolve;
      }),
    );
    const pending = useWorkspaceContextStore
      .getState()
      .setContext({ kind: 'organization', organizationId: ORG_A });
    const switched: WorkspaceContextState = {
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 5,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    };
    useWorkspaceContextStore
      .getState()
      .applyBroadcast({ ...switched, reason: 'switch' });
    resolveSet(switched);

    await expect(pending).resolves.toEqual(switched);
    expect(useWorkspaceContextStore.getState().state).toEqual(switched);
  });

  it('still rejects a switch when a broadcast moved the context elsewhere', async (): Promise<void> => {
    let resolveSet: (state: WorkspaceContextState) => void = (): void => {};
    mockSet.mockReturnValue(
      new Promise<WorkspaceContextState>((resolve): void => {
        resolveSet = resolve;
      }),
    );
    const pending = useWorkspaceContextStore
      .getState()
      .setContext({ kind: 'organization', organizationId: ORG_A });
    const elsewhere: WorkspaceContextState = {
      context: { kind: 'personal' },
      revision: 6,
      organizations: [],
    };
    useWorkspaceContextStore
      .getState()
      .applyBroadcast({ ...elsewhere, reason: 'switch' });
    resolveSet({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 5,
      organizations: [],
    });

    await expect(pending).rejects.toMatchObject({ code: 'stale-revision' });
    expect(useWorkspaceContextStore.getState().state).toEqual(elsewhere);
  });

  it('rejects a switch reply that started under a previous account', async (): Promise<void> => {
    let resolveSet: (state: WorkspaceContextState) => void = () => {};
    mockSet.mockReturnValue(
      new Promise<WorkspaceContextState>((resolve) => {
        resolveSet = resolve;
      }),
    );
    const pending = useWorkspaceContextStore
      .getState()
      .setContext({ kind: 'organization', organizationId: ORG_A });
    useWorkspaceContextStore.getState().applyBroadcast({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
      reason: 'account-change',
    });
    resolveSet({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 9,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    });
    await expect(pending).rejects.toMatchObject({ code: 'account-changed' });
    expect(useWorkspaceContextStore.getState().state).toEqual({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    });
  });
});
