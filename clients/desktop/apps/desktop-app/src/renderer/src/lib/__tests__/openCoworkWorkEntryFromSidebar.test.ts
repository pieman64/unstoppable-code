/**
 * Sidebar Cowork navigation helpers (CAN-2552).
 *
 * Both helpers wrap a fire-and-forget navigation, so the only thing standing
 * between a genuine failure and a click that appears to do nothing is the
 * `.catch` in each. These tests pin that, plus the distinction the workspace
 * helper has to make: `switchChatProject` resolving `false` means a newer
 * navigation superseded this one, which is an ordinary outcome and must not
 * raise a toast.
 */
const addToast = jest.fn();
const openWorkEntryFromSidebar = jest.fn(() => Promise.resolve());
const switchChatProject = jest.fn(() => Promise.resolve(true));

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): unknown => ({ addToast }) },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): unknown => ({ openWorkEntryFromSidebar, switchChatProject }),
  },
}));

import {
  openCoworkWorkEntryFromSidebar,
  selectCoworkWorkspaceFromSidebar,
} from '../openCoworkWorkEntryFromSidebar';

/** Lets the helper's `void`ed promise chain settle before assertions. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('sidebar cowork navigation helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    openWorkEntryFromSidebar.mockImplementation(() => Promise.resolve());
    switchChatProject.mockImplementation(() => Promise.resolve(true));
  });

  it('stays quiet when opening a task succeeds', async () => {
    openCoworkWorkEntryFromSidebar('workspace-1', 'entry-1');
    await flush();

    expect(openWorkEntryFromSidebar).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
    expect(addToast).not.toHaveBeenCalled();
  });

  it('tells the user when opening a task fails', async () => {
    openWorkEntryFromSidebar.mockImplementationOnce(() =>
      Promise.reject(new Error('Chat project not found')),
    );

    openCoworkWorkEntryFromSidebar('workspace-1', 'entry-1');
    await flush();

    expect(addToast).toHaveBeenCalledWith(
      "Couldn't open the task. Try again.",
      'error',
    );
  });

  it('stays quiet when selecting a workspace succeeds', async () => {
    selectCoworkWorkspaceFromSidebar('workspace-1');
    await flush();

    expect(switchChatProject).toHaveBeenCalledWith('workspace-1');
    expect(addToast).not.toHaveBeenCalled();
  });

  it('tells the user when selecting a genuinely absent workspace fails', async () => {
    switchChatProject.mockImplementationOnce(() =>
      Promise.reject(new Error('Chat project not found')),
    );

    selectCoworkWorkspaceFromSidebar('ghost-workspace');
    await flush();

    // Without this the row is dead: the rejection is swallowed by `void` and
    // the click looks ignored.
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't open the workspace. Try again.",
      'error',
    );
  });

  it('does not toast when a workspace selection was merely superseded', async () => {
    switchChatProject.mockImplementationOnce(() => Promise.resolve(false));

    selectCoworkWorkspaceFromSidebar('workspace-1');
    await flush();

    // `false` means a newer navigation owns the state — the user already got
    // what they asked for, so a failure toast would be a lie.
    expect(addToast).not.toHaveBeenCalled();
  });
});
