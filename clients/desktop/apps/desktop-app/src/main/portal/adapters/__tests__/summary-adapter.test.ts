import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { refreshWorktreeSummary } from '../../../services/worktree-summary-service';
import { handlePortalSummaryRefresh } from '../summary-adapter';
import type { PortalAdapterContext } from '../types';

jest.mock('../../../services/worktree-summary-service', () => ({
  refreshWorktreeSummary: jest.fn(),
}));

const mockedRefresh = jest.mocked(refreshWorktreeSummary);

describe('summary portal adapter', () => {
  it('triggers long-running work and ACKs immediately without awaiting it', () => {
    const command = {
      id: 'cmd-summary',
      sequence: 3,
      type: 'portal.summary.refresh',
      payload: { projectId: 'project-a', worktreeId: 'worktree-a' },
      createdAt: '2026-07-27T00:00:00.000Z',
      expiresAt: null,
    } satisfies PortalCommandEnvelope;
    const getWindow = jest.fn(() => null);
    const complete = jest.fn();
    const context: PortalAdapterContext = {
      getWindow,
      enqueueEvent: jest.fn(),
      complete,
      fail: jest.fn(),
    };

    handlePortalSummaryRefresh(command, context);

    expect(mockedRefresh).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      getWindow,
    );
    expect(complete).toHaveBeenCalledWith(command);
  });
});
