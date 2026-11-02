import {
  maybeFireOsNotification,
  shouldShowInAppNotification,
} from '@/lib/osNotifications';
import { useGitHubStore } from '../githubStore';

jest.mock('@/lib/osNotifications', () => ({
  ...jest.requireActual<object>('@/lib/osNotifications'),
  maybeFireOsNotification: jest.fn(),
  shouldShowInAppNotification: jest.fn(),
}));

// Save confirmations such as the Cursor rules result (CAN-4676) rely on these
// two flags: the user just acted, so the result shows in the app even with
// in-app notifications off and never becomes an OS banner.
describe('addToast delivery flags', () => {
  beforeEach(() => {
    useGitHubStore.setState({ toasts: [], notifications: [] });
    jest.mocked(maybeFireOsNotification).mockClear();
    jest.mocked(shouldShowInAppNotification).mockReturnValue(false);
  });

  it('hides a toast when in-app notifications are off', () => {
    useGitHubStore.getState().addToast('Saved.', 'success');
    expect(useGitHubStore.getState().toasts).toHaveLength(0);
    expect(maybeFireOsNotification).toHaveBeenCalledTimes(1);
  });

  it('shows a forced toast with in-app notifications off and skips the OS banner when suppressed', () => {
    useGitHubStore.getState().addToast('Saved.', 'success', undefined, {
      title: 'Cursor rules on',
      forceInApp: true,
      suppressOsNotification: true,
    });
    expect(useGitHubStore.getState().toasts.map((t) => t.message)).toEqual([
      'Saved.',
    ]);
    expect(maybeFireOsNotification).not.toHaveBeenCalled();
  });
});
