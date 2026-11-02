import type { WorkspaceContextState } from '@canopy/desktop-shared/types';

const mockSet = jest.fn<Promise<WorkspaceContextState>, [unknown]>();

jest.mock('../renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { selectOrganizationWhenListed } from '../selectOrganizationWhenListed';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function listed(...ids: string[]): WorkspaceContextState['organizations'] {
  return ids.map((id) => ({ id, name: id, role: 'MEMBER' }));
}

function applyMembership(revision: number, ...ids: string[]): void {
  useWorkspaceContextStore.getState().applyBroadcast({
    context: { kind: 'personal' },
    revision,
    organizations: listed(...ids),
    reason: 'organizations',
  });
}

describe('selectOrganizationWhenListed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'personal' },
        revision: 1,
        organizations: listed(ORG_A),
      },
      hydrated: true,
      lastChangeReason: null,
      accountEpoch: 0,
      appliedGeneration: 0,
    });
    mockSet.mockImplementation((request) =>
      Promise.resolve({
        context: (request as { context: WorkspaceContextState['context'] })
          .context,
        revision: 2,
        organizations: listed(ORG_A, ORG_B),
      }),
    );
    Object.defineProperty(globalThis, 'window', {
      value: { api: { workspaceContext: { set: mockSet } } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('selects an organization main already lists', () => {
    selectOrganizationWhenListed(ORG_A);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: ORG_A },
      expectedRevision: 1,
    });
  });

  it('waits for the membership broadcast that lists a new organization', () => {
    selectOrganizationWhenListed(ORG_B);
    expect(mockSet).not.toHaveBeenCalled();

    applyMembership(2, ORG_A, ORG_B);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: ORG_B },
      expectedRevision: 2,
    });
    // Settled: later broadcasts do not switch again.
    applyMembership(3, ORG_A, ORG_B);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest request', () => {
    selectOrganizationWhenListed(ORG_B);
    useWorkspaceContextStore.setState({ hydrated: false });
    selectOrganizationWhenListed(ORG_A);
    useWorkspaceContextStore.setState({ hydrated: true });

    applyMembership(2, ORG_A, ORG_B);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { kind: 'organization', organizationId: ORG_A },
      }),
    );
  });

  it('drops a request main never lists', () => {
    selectOrganizationWhenListed(ORG_B);
    jest.advanceTimersByTime(15_000);

    applyMembership(2, ORG_A, ORG_B);

    expect(mockSet).not.toHaveBeenCalled();
  });

  // CAN-3672: the switcher opens Projects only after the switch lands.
  describe('onSettled', () => {
    async function flush(): Promise<void> {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }

    it('bounds an in-flight selection and ignores its late completion', async () => {
      let complete: (value: WorkspaceContextState) => void = () => {};
      mockSet.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const onSettled = jest.fn();
      selectOrganizationWhenListed(ORG_A, onSettled);
      jest.advanceTimersByTime(15_000);
      expect(onSettled.mock.calls).toEqual([[false]]);
      complete(useWorkspaceContextStore.getState().state);
      await flush();
      expect(onSettled.mock.calls).toEqual([[false]]);
    });

    it('reports a landed switch once', async () => {
      const onSettled = jest.fn();
      selectOrganizationWhenListed(ORG_B, onSettled);
      applyMembership(2, ORG_A, ORG_B);
      await flush();
      applyMembership(3, ORG_A, ORG_B);
      await flush();
      expect(onSettled.mock.calls).toEqual([[true]]);
    });

    it('reports a timeout and a replaced request as not selected', () => {
      const timedOut = jest.fn();
      selectOrganizationWhenListed(ORG_B, timedOut);
      jest.advanceTimersByTime(15_000);
      expect(timedOut.mock.calls).toEqual([[false]]);

      const replaced = jest.fn();
      selectOrganizationWhenListed(ORG_B, replaced);
      selectOrganizationWhenListed(ORG_A);
      expect(replaced.mock.calls).toEqual([[false]]);
    });

    it('reports a refused switch as not selected', async () => {
      mockSet.mockRejectedValueOnce(new Error('refused'));
      const onSettled = jest.fn();
      selectOrganizationWhenListed(ORG_A, onSettled);
      await flush();
      expect(onSettled.mock.calls).toEqual([[false]]);
    });
  });
});
