/**
 * CAN-3383 client guards: the viewer data-sharing status and the admin memory
 * participation list are both rejected unless every field is present and
 * well-formed, so a partial response can never render a hint or a label.
 */
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  fetchMemoryParticipation,
  fetchViewerDataSharing,
  TeamApiError,
} from '../team-api';
import { failWith, respondWith } from './helpers/settings-responses';

const ORG_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const VIEWER_ID = '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70';

async function captureError(promise: Promise<unknown>): Promise<TeamApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TeamApiError) return error;
    throw error;
  }
  throw new Error('Expected the request to reject');
}

const VALID_STATUS = {
  viewerUserId: VIEWER_ID,
  scopes: {
    metadata: 'private',
    plans: 'shared',
    summaries: 'unknown',
    transcripts: 'prohibited',
  },
};

function viewerClient(
  body: unknown,
): ReturnType<typeof createFakeSettingsClient> {
  return createFakeSettingsClient({
    'organization.dataSharing.viewer': respondWith(
      'organization.dataSharing.viewer',
      body,
    ),
  });
}

describe('fetchViewerDataSharing', (): void => {
  it('reads the viewer-only operation for the organization', async (): Promise<void> => {
    const client = viewerClient(VALID_STATUS);
    await expect(fetchViewerDataSharing(client, ORG_ID)).resolves.toEqual(
      VALID_STATUS,
    );
    expect(client.calls).toEqual([
      {
        operation: 'organization.dataSharing.viewer',
        input: { organizationId: ORG_ID },
      },
    ]);
  });

  it.each([
    ['a missing viewer id', { scopes: VALID_STATUS.scopes }],
    [
      'a non-UUID viewer id',
      { viewerUserId: 'user-1', scopes: VALID_STATUS.scopes },
    ],
    ['missing scopes', { viewerUserId: VIEWER_ID }],
    [
      'a missing scope',
      {
        viewerUserId: VIEWER_ID,
        scopes: { metadata: 'private', plans: 'private', summaries: 'private' },
      },
    ],
    [
      'an unexpected scope value',
      {
        viewerUserId: VIEWER_ID,
        scopes: { ...VALID_STATUS.scopes, plans: 'withheld' },
      },
    ],
    ['an array body', [VALID_STATUS]],
    ['a null body', null],
  ])('rejects %s', async (_label, body): Promise<void> => {
    const error = await captureError(
      fetchViewerDataSharing(viewerClient(body), ORG_ID),
    );
    expect(error.serverDetail).toBe('Invalid server response');
  });

  it('surfaces a non-member 404 as a TeamApiError', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.dataSharing.viewer': failWith(404, {
        error: 'Organization not found',
      }),
    });
    const error = await captureError(fetchViewerDataSharing(client, ORG_ID));
    expect(error.status).toBe(404);
    expect(error.serverDetail).toBe('Organization not found');
  });
});

describe('fetchMemoryParticipation', (): void => {
  const member = {
    userId: VIEWER_ID,
    name: 'Ada',
    email: 'ada@example.com',
    role: 'MEMBER',
    memoryEnabled: true,
    contributingRecently: false,
  };

  function participationClient(
    body: unknown,
  ): ReturnType<typeof createFakeSettingsClient> {
    return createFakeSettingsClient({
      'organization.settings.memoryParticipation': respondWith(
        'organization.settings.memoryParticipation',
        body,
      ),
    });
  }

  it('accepts members with the recent-contribution flag', async (): Promise<void> => {
    const client = participationClient({ members: [member] });
    await expect(fetchMemoryParticipation(client, ORG_ID)).resolves.toEqual({
      members: [member],
    });
    expect(client.calls).toEqual([
      {
        operation: 'organization.settings.memoryParticipation',
        input: { organizationId: ORG_ID },
      },
    ]);
  });

  it('rejects members without the recent-contribution flag', async (): Promise<void> => {
    // The pre-CAN-3383 shape: every field except the new flag.
    const legacy = {
      userId: member.userId,
      name: member.name,
      email: member.email,
      role: member.role,
      memoryEnabled: member.memoryEnabled,
    };
    const error = await captureError(
      fetchMemoryParticipation(
        participationClient({ members: [legacy] }),
        ORG_ID,
      ),
    );
    expect(error.serverDetail).toBe('Invalid server response');
  });

  it('rejects a non-boolean recent-contribution flag', async (): Promise<void> => {
    const error = await captureError(
      fetchMemoryParticipation(
        participationClient({
          members: [{ ...member, contributingRecently: 'no' }],
        }),
        ORG_ID,
      ),
    );
    expect(error.serverDetail).toBe('Invalid server response');
  });
});
