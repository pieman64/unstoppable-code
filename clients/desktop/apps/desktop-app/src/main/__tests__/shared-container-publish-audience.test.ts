import type {
  ListSharedContainerRecipientsResponse,
  SharedContainerLink,
} from '@canopy/protocol/shared-containers';
import {
  getSharedContainerLink,
  listSharedContainerRecipients,
} from '../shared-containers/canopy-server-client';
import { hasSharedContainerPublishAudience } from '../shared-containers/publish/scheduler';

jest.mock('../shared-containers/canopy-server-client', () => ({
  getSharedContainerLink: jest.fn(),
  listSharedContainerRecipients: jest.fn(),
}));

const listRecipients = jest.mocked(listSharedContainerRecipients);
const getLink = jest.mocked(getSharedContainerLink);

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  organizationId: 'org-1',
  containerId: 'container-1',
  containerType: 'CODE_WORKTREE' as const,
};

function recipients(count: number): ListSharedContainerRecipientsResponse {
  return {
    recipients: Array.from({ length: count }, (_, index) => ({
      id: `grant-${String(index)}`,
      containerId: 'container-1',
      recipient: {
        kind: 'member',
        userId: `user-${String(index)}`,
        name: 'Teammate',
      },
      capabilities: ['VIEW'],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    })),
    nextCursor: null,
  };
}

describe('hasSharedContainerPublishAudience', () => {
  beforeEach(() => {
    listRecipients.mockReset();
    getLink.mockReset();
  });

  it('publishes a container that has recipients without asking for its link', async () => {
    listRecipients.mockResolvedValue(recipients(1));

    await expect(hasSharedContainerPublishAudience(target)).resolves.toBe(true);
    expect(listRecipients).toHaveBeenCalledWith({
      containerId: 'container-1',
      organizationId: 'org-1',
      limit: 1,
    });
    expect(getLink).not.toHaveBeenCalled();
  });

  it('publishes a link-only container that nobody has joined yet', async () => {
    listRecipients.mockResolvedValue(recipients(0));
    const link: SharedContainerLink = {
      audience: 'ANYONE',
      url: '/share/view/token',
    };
    getLink.mockResolvedValue(link);

    await expect(hasSharedContainerPublishAudience(target)).resolves.toBe(true);
    expect(getLink).toHaveBeenCalledWith('container-1');
  });

  it('skips a container with no recipients and no link', async () => {
    listRecipients.mockResolvedValue(recipients(0));
    getLink.mockResolvedValue(null);

    await expect(hasSharedContainerPublishAudience(target)).resolves.toBe(
      false,
    );
  });
});
