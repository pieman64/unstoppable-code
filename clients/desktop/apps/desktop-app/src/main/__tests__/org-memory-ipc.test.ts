import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const registered = new Map<string, (...args: unknown[]) => unknown>();
const submitOrgMemoryFeedbackMock = jest.fn();
const getOrgMemoryFeedbackMock = jest.fn();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(channel, handler);
    },
  ),
}));

jest.mock('../memory/memory-client', () => ({
  getOrgMemoryFeedback: (...args: unknown[]): unknown =>
    getOrgMemoryFeedbackMock(...args),
  submitOrgMemoryFeedback: (...args: unknown[]): unknown =>
    submitOrgMemoryFeedbackMock(...args),
}));

import { registerOrgMemoryHandlers } from '../ipc/org-memory';

const FACT_ID = '22222222-2222-4222-8222-222222222222';
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

function handler(
  channel: string = IPC_CHANNELS.orgMemoryFeedbackSubmit,
): (...args: unknown[]) => unknown {
  const registeredHandler = registered.get(channel);
  if (!registeredHandler) throw new Error('Handler not registered');
  return registeredHandler;
}

describe('org-memory IPC handlers', () => {
  beforeEach(() => {
    registered.clear();
    submitOrgMemoryFeedbackMock.mockReset();
    submitOrgMemoryFeedbackMock.mockResolvedValue({ recorded: true });
    getOrgMemoryFeedbackMock.mockReset();
    getOrgMemoryFeedbackMock.mockResolvedValue({
      feedback: null,
      canSubmit: true,
    });
    registerOrgMemoryHandlers();
  });

  it('forwards a normalized rating and trimmed comment', async () => {
    await expect(
      handler()(undefined, {
        organizationExternalId: ORG_ID,
        searchId: SEARCH_ID,
        factId: FACT_ID,
        rating: 'dislike',
        comment: '  Stale port.  ',
      }),
    ).resolves.toEqual({ recorded: true });
    expect(submitOrgMemoryFeedbackMock).toHaveBeenCalledWith({
      organizationExternalId: ORG_ID,
      searchId: SEARCH_ID,
      factId: FACT_ID,
      rating: 'dislike',
      comment: 'Stale port.',
    });
  });

  it('returns recorded:false without a rating or comment', async () => {
    await expect(
      handler()(undefined, {
        organizationExternalId: ORG_ID,
        searchId: SEARCH_ID,
        factId: FACT_ID,
        comment: '   ',
      }),
    ).resolves.toEqual({ recorded: false });
    expect(submitOrgMemoryFeedbackMock).not.toHaveBeenCalled();
  });

  it('rejects malformed fact ids at the IPC boundary', async () => {
    await expect(
      handler()(undefined, {
        organizationExternalId: ORG_ID,
        searchId: SEARCH_ID,
        factId: '../evil',
        rating: 'like',
      }),
    ).rejects.toThrow('Invalid factId');
    expect(submitOrgMemoryFeedbackMock).not.toHaveBeenCalled();
  });

  it('drops unknown rating values instead of forwarding them', async () => {
    await expect(
      handler()(undefined, {
        organizationExternalId: ORG_ID,
        searchId: SEARCH_ID,
        factId: FACT_ID,
        rating: 'meh',
      }),
    ).resolves.toEqual({ recorded: false });
    expect(submitOrgMemoryFeedbackMock).not.toHaveBeenCalled();
  });

  it('retrieves feedback for a validated occurrence', async () => {
    const request = {
      organizationExternalId: ORG_ID,
      searchId: SEARCH_ID,
      factId: FACT_ID,
    };
    await expect(
      handler(IPC_CHANNELS.orgMemoryFeedbackGet)(undefined, request),
    ).resolves.toEqual({ feedback: null, canSubmit: true });
    expect(getOrgMemoryFeedbackMock).toHaveBeenCalledWith(request);
  });

  it('fails closed for non-string feedback query ids', async () => {
    await expect(
      handler(IPC_CHANNELS.orgMemoryFeedbackGet)(undefined, {
        organizationExternalId: ORG_ID,
        searchId: 123,
        factId: FACT_ID,
      }),
    ).resolves.toEqual({ feedback: null, canSubmit: false });
    expect(getOrgMemoryFeedbackMock).not.toHaveBeenCalled();
  });

  // CAN-3457: feedback goes to the org the occurrence was searched in. A
  // legacy occurrence without one stays read-only; the handler never guesses.
  it.each([
    ['missing', undefined],
    ['malformed', 'org-1'],
    ['non-string', 42],
  ])(
    'refuses feedback with a %s org',
    async (_case, organizationExternalId) => {
      await expect(
        handler()(undefined, {
          organizationExternalId,
          searchId: SEARCH_ID,
          factId: FACT_ID,
          rating: 'like',
        }),
      ).resolves.toEqual({ recorded: false });
      await expect(
        handler(IPC_CHANNELS.orgMemoryFeedbackGet)(undefined, {
          organizationExternalId,
          searchId: SEARCH_ID,
          factId: FACT_ID,
        }),
      ).resolves.toEqual({ feedback: null, canSubmit: false });
      expect(submitOrgMemoryFeedbackMock).not.toHaveBeenCalled();
      expect(getOrgMemoryFeedbackMock).not.toHaveBeenCalled();
    },
  );

  it('forwards the org lowercased', async () => {
    await handler()(undefined, {
      organizationExternalId: ORG_ID.toUpperCase(),
      searchId: SEARCH_ID,
      factId: FACT_ID,
      rating: 'like',
    });
    expect(submitOrgMemoryFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationExternalId: ORG_ID }),
    );
  });
});
