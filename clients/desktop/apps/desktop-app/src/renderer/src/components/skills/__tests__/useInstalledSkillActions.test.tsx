/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstalledSkillInfo,
  SkillUpdateProgress,
} from '@canopy/desktop-shared/types/skills';

let resetWorkspaceContext: (() => void) | null = null;
jest.mock('@/hooks/useWorkspaceContextReset', () => ({
  useWorkspaceContextReset: (reset: () => void): void => {
    resetWorkspaceContext = reset;
  },
}));
jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): { requestShare: jest.Mock; shareGateModal: null } => ({
    requestShare: jest.fn(),
    shareGateModal: null,
  }),
}));
jest.mock('../ShareSkillModal', () => ({ ShareSkillModal: (): null => null }));
jest.mock('../../shared', () => ({ DeleteConfirmModal: (): null => null }));

import {
  useInstalledSkillActions,
  type InstalledSkillActions,
  type InstalledSkillActionsOptions,
} from '../useInstalledSkillActions';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The update-status store is shared by every hook instance in the renderer;
// each test uses its own skill name so earlier results cannot leak in.
let skillCounter = 0;
function makeSkill(
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo {
  skillCounter += 1;
  return {
    name: `skill-${skillCounter}`,
    description: 'A skill',
    sourceId: 'github:owner:repo',
    source: 'owner/repo',
    sourceType: 'github',
    installedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    ...overrides,
  };
}

function keyOf(skill: InstalledSkillInfo): string {
  return `${skill.sourceId}/${skill.name}`;
}

const checkUpdates = jest.fn<
  Promise<{ success: boolean; data?: Record<string, boolean>; error?: string }>,
  []
>();
const updateSkill = jest.fn<
  Promise<{ success: boolean; error?: string }>,
  [string, string]
>();
let progressListeners: Array<(progress: SkillUpdateProgress) => void> = [];

function emitProgress(progress: SkillUpdateProgress): void {
  act(() => progressListeners.forEach((listener) => listener(progress)));
}

const roots: Root[] = [];

function renderActions(options: Partial<InstalledSkillActionsOptions> = {}): {
  current: () => InstalledSkillActions;
  root: Root;
  rerender: () => void;
} {
  let latest: InstalledSkillActions | null = null;
  function Harness(): ReactElement {
    latest = useInstalledSkillActions({
      onSkillsChanged: () => Promise.resolve(),
      ...options,
    });
    return <></>;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(<Harness />));
  return {
    current: (): InstalledSkillActions => {
      if (!latest) throw new Error('hook did not render');
      return latest;
    },
    root,
    rerender: (): void => act(() => root.render(<Harness />)),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  checkUpdates.mockReset();
  updateSkill.mockReset();
  progressListeners = [];
  resetWorkspaceContext = null;
  Object.assign(window, {
    skills: {
      checkUpdates,
      updateSkill,
      onUpdateProgress: (listener: (progress: SkillUpdateProgress) => void) => {
        progressListeners.push(listener);
        return (): void => {
          progressListeners = progressListeners.filter((l) => l !== listener);
        };
      },
    },
  });
});

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
});

describe('useInstalledSkillActions updates (CAN-4264)', () => {
  it('keeps the legacy eligibility: not built-in and not custom', () => {
    const { current } = renderActions();
    expect(current().canUpdate(makeSkill())).toBe(true);
    expect(current().canUpdate(makeSkill({ builtIn: true }))).toBe(false);
    expect(current().canUpdate(makeSkill({ custom: true }))).toBe(false);
  });

  it('shows cached availability without checking on mount', () => {
    const skill = makeSkill({ updateAvailable: true });
    const { current } = renderActions();
    expect(current().updateAvailable(skill)).toBe(true);
    expect(current().updatePending).toBe('none');
    expect(checkUpdates).not.toHaveBeenCalled();
  });

  it('reads the skill from the whole-inventory check by its canonical key', async () => {
    const skill = makeSkill();
    const other = makeSkill({ updateAvailable: true });
    const check = deferred<{
      success: boolean;
      data?: Record<string, boolean>;
    }>();
    checkUpdates.mockReturnValueOnce(check.promise);
    const { current } = renderActions();

    act(() => current().checkUpdates());
    act(() => current().checkUpdates());
    expect(checkUpdates).toHaveBeenCalledTimes(1);
    expect(current().updatePending).toBe('checking');

    // An omitted key keeps what is known; explicit false replaces true.
    await act(async () => {
      check.resolve({
        success: true,
        data: { [keyOf(skill)]: true, [keyOf(other)]: false },
      });
      await check.promise;
    });

    expect(current().updatePending).toBe('none');
    expect(current().updateAvailable(skill)).toBe(true);
    expect(current().updateAvailable(other)).toBe(false);
    expect(
      current().updateAvailable(makeSkill({ updateAvailable: true })),
    ).toBe(true);
  });

  it('lets a reinstall after a check supersede its remembered update', async () => {
    const skill = makeSkill({
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    checkUpdates.mockResolvedValueOnce({
      success: true,
      data: { [keyOf(skill)]: true },
    });
    const { current } = renderActions();
    act(() => current().checkUpdates());
    await flush();
    expect(current().updateAvailable(skill)).toBe(true);

    // Removed and installed again: the new install has no known update.
    const later = new Date(Date.now() + 60_000).toISOString();
    const reinstalled = {
      ...skill,
      installedAt: later,
      updatedAt: later,
      updateAvailable: false,
    };
    expect(current().updateAvailable(reinstalled)).toBe(false);
    // The record the check saw keeps its result.
    expect(current().updateAvailable(skill)).toBe(true);
  });

  it('reports a failed check, keeps known availability, and allows retry', async () => {
    const skill = makeSkill({ updateAvailable: true });
    checkUpdates.mockResolvedValueOnce({ success: false });
    const { current } = renderActions();

    act(() => current().checkUpdates());
    await flush();
    expect(current().updateErrorFor(skill)).toBe(
      'Failed to check for updates.',
    );
    expect(current().updateAvailable(skill)).toBe(true);

    checkUpdates.mockRejectedValueOnce(new Error('GitHub unavailable'));
    act(() => current().checkUpdates());
    expect(current().updateErrorFor(skill)).toBeNull();
    await flush();
    expect(current().updateErrorFor(skill)).toBe('GitHub unavailable');
    expect(current().updatePending).toBe('none');
    expect(current().updateAvailable(skill)).toBe(true);

    checkUpdates.mockResolvedValueOnce({
      success: true,
      data: { [keyOf(skill)]: false },
    });
    act(() => current().checkUpdates());
    await flush();
    expect(current().updateErrorFor(skill)).toBeNull();
    expect(current().updateAvailable(skill)).toBe(false);
  });

  it('applies with the canonical identity, guards duplicates, and refreshes', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const apply = deferred<{ success: boolean }>();
    updateSkill.mockReturnValueOnce(apply.promise);
    const onSkillsChanged = jest.fn(() => Promise.resolve());
    const onSkillUpdated = jest.fn();
    const { current } = renderActions({ onSkillsChanged, onSkillUpdated });

    act(() => {
      current().applyUpdate(skill);
      current().applyUpdate(skill);
    });
    act(() => current().checkUpdates());
    expect(updateSkill).toHaveBeenCalledTimes(1);
    expect(updateSkill).toHaveBeenCalledWith(skill.sourceId, skill.name);
    expect(checkUpdates).not.toHaveBeenCalled();
    expect(current().updatePending).toBe('applying');
    expect(current().isUpdating(skill)).toBe(true);

    await act(async () => {
      apply.resolve({ success: true });
      await Promise.resolve();
      await apply.promise;
    });
    await flush();

    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
    expect(onSkillUpdated).toHaveBeenCalledWith({
      sourceId: skill.sourceId,
      name: skill.name,
    });
    expect(current().updatePending).toBe('none');
    // The inventory row read before the refresh still says true.
    expect(current().updateAvailable(skill)).toBe(false);
  });

  it('never starts a second update of a skill from another view', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const apply = deferred<{ success: boolean }>();
    updateSkill.mockReturnValueOnce(apply.promise);
    // The detail page and the Installed Skills list behind it.
    const detail = renderActions();
    const list = renderActions();

    act(() => detail.current().applyUpdate(skill));
    expect(list.current().isUpdating(skill)).toBe(true);
    act(() => list.current().applyUpdate(skill));
    expect(updateSkill).toHaveBeenCalledTimes(1);

    await act(async () => {
      apply.resolve({ success: true });
      await apply.promise;
    });
    await flush();
    expect(list.current().isUpdating(skill)).toBe(false);
    expect(detail.current().isUpdating(skill)).toBe(false);
  });

  it('keeps availability and reports a failed or rejected update', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const onSkillUpdated = jest.fn();
    updateSkill.mockResolvedValueOnce({ success: false });
    const { current } = renderActions({ onSkillUpdated });

    act(() => current().applyUpdate(skill));
    await flush();
    expect(current().updateErrorFor(skill)).toBe('Failed to update skill.');
    expect(current().updateAvailable(skill)).toBe(true);
    expect(current().updatePending).toBe('none');

    updateSkill.mockRejectedValueOnce(new Error('Download failed'));
    act(() => current().applyUpdate(skill));
    await flush();
    expect(current().updateErrorFor(skill)).toBe('Download failed');
    expect(current().updateAvailable(skill)).toBe(true);
    expect(onSkillUpdated).not.toHaveBeenCalled();
  });

  it('reports a refresh failure after a successful update as such', async () => {
    const skill = makeSkill({ updateAvailable: true });
    updateSkill.mockResolvedValueOnce({ success: true });
    const onSkillUpdated = jest.fn();
    const { current } = renderActions({
      onSkillsChanged: () => Promise.reject(new Error('read failed')),
      onSkillUpdated,
    });

    act(() => current().applyUpdate(skill));
    await flush();
    expect(current().updateErrorFor(skill)).toBe(
      'The skill was updated, but the latest version couldn’t be loaded. Reopen the skill to see it.',
    );
    expect(current().updateAvailable(skill)).toBe(false);
    expect(onSkillUpdated).toHaveBeenCalledTimes(1);
  });

  it('never lets a check that started before an update restore availability', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const check = deferred<{
      success: boolean;
      data?: Record<string, boolean>;
    }>();
    checkUpdates.mockReturnValueOnce(check.promise);
    updateSkill.mockResolvedValueOnce({ success: true });
    const list = renderActions();
    const detail = renderActions();

    act(() => list.current().checkUpdates());
    act(() => detail.current().applyUpdate(skill));
    await flush();
    await act(async () => {
      check.resolve({ success: true, data: { [keyOf(skill)]: true } });
      await check.promise;
    });

    expect(detail.current().updateAvailable(skill)).toBe(false);
    expect(list.current().updateAvailable(skill)).toBe(false);
  });

  it('converges every mounted instance on progress and applied updates', async () => {
    const skill = makeSkill();
    const list = renderActions();
    const detail = renderActions();

    emitProgress({
      operation: 'check-updates',
      status: 'running',
      message: '',
    });
    expect(list.current().updatePending).toBe('checking');
    expect(detail.current().updatePending).toBe('checking');

    emitProgress({
      operation: 'check-updates',
      status: 'complete',
      message: '',
      updateMap: { [keyOf(skill)]: true },
    });
    expect(list.current().updatePending).toBe('none');
    expect(list.current().updateAvailable(skill)).toBe(true);
    expect(detail.current().updateAvailable(skill)).toBe(true);

    updateSkill.mockResolvedValueOnce({ success: true });
    act(() => detail.current().applyUpdate(skill));
    await flush();
    expect(list.current().updateAvailable(skill)).toBe(false);

    emitProgress({
      operation: 'check-updates',
      status: 'error',
      message: 'Rate limited',
    });
    expect(list.current().updateErrorFor(skill)).toBe('Rate limited');
    expect(list.current().updatePending).toBe('none');
  });

  it('refreshes the list inventory when a check completes', () => {
    const onUpdateCheckComplete = jest.fn();
    renderActions({ onUpdateCheckComplete });
    emitProgress({
      operation: 'check-updates',
      status: 'complete',
      message: '',
      updateMap: {},
    });
    expect(onUpdateCheckComplete).toHaveBeenCalledTimes(1);
  });

  it('ignores completions from before a workspace context switch', async () => {
    const skill = makeSkill();
    const check = deferred<{
      success: boolean;
      data?: Record<string, boolean>;
    }>();
    checkUpdates.mockReturnValueOnce(check.promise);
    const { current } = renderActions();

    act(() => current().checkUpdates());
    act(() => resetWorkspaceContext?.());
    expect(current().updatePending).toBe('none');

    await act(async () => {
      check.resolve({ success: false, error: 'stale' });
      await check.promise;
    });
    expect(current().updateErrorFor(skill)).toBeNull();
    // A new check is not blocked by the abandoned one.
    checkUpdates.mockResolvedValueOnce({ success: true, data: {} });
    act(() => current().checkUpdates());
    expect(checkUpdates).toHaveBeenCalledTimes(2);
  });

  it.each(['skill', 'workspace'])(
    'keeps a newer check authoritative after a %s switch',
    async (context) => {
      const skill = makeSkill();
      const first = deferred<{
        success: boolean;
        data: Record<string, boolean>;
      }>();
      const second = deferred<{
        success: boolean;
        data: Record<string, boolean>;
      }>();
      checkUpdates
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const options = { updateContextKey: 'first' };
      const detail = renderActions(options);
      const resetDetail = resetWorkspaceContext;
      const list = renderActions();
      act(() => detail.current().checkUpdates());
      emitProgress({
        operation: 'check-updates',
        status: 'running',
        message: '',
      });

      if (context === 'skill') {
        options.updateContextKey = 'second';
        detail.rerender();
      } else {
        act(() => resetDetail?.());
      }

      const current = detail.current;
      expect(current().updatePending).toBe('none');
      act(() => current().checkUpdates());
      emitProgress({
        operation: 'check-updates',
        status: 'running',
        message: '',
      });
      emitProgress({
        operation: 'check-updates',
        status: 'complete',
        message: '',
        updateMap: { [keyOf(skill)]: false },
      });
      await act(async () => {
        first.resolve({ success: true, data: { [keyOf(skill)]: false } });
        await first.promise;
      });
      expect(current().updatePending).toBe('checking');
      emitProgress({
        operation: 'check-updates',
        status: 'complete',
        message: '',
        updateMap: { [keyOf(skill)]: true },
      });
      await act(async () => {
        second.resolve({ success: true, data: { [keyOf(skill)]: true } });
        await second.promise;
      });
      await flush();
      expect(current().updateAvailable(skill)).toBe(true);
      expect(list.current().updateAvailable(skill)).toBe(true);
      expect(current().updatePending).toBe('none');
    },
  );

  it('unsubscribes from progress and skips callbacks after unmount', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const apply = deferred<{ success: boolean }>();
    updateSkill.mockReturnValueOnce(apply.promise);
    const onSkillUpdated = jest.fn();
    const { current, root } = renderActions({ onSkillUpdated });
    expect(progressListeners).toHaveLength(1);

    act(() => current().applyUpdate(skill));
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(progressListeners).toHaveLength(0);

    await act(async () => {
      apply.resolve({ success: true });
      await Promise.resolve();
      await apply.promise;
    });
    expect(onSkillUpdated).not.toHaveBeenCalled();
    // The update still happened: a later surface sees it.
    expect(renderActions().current().updateAvailable(skill)).toBe(false);
  });

  it('scopes an update error to its skill and clears it on request', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const other = makeSkill();
    updateSkill.mockResolvedValueOnce({ success: false, error: 'Nope' });
    const { current } = renderActions();

    act(() => current().applyUpdate(skill));
    await flush();
    expect(current().updateErrorFor(skill)).toBe('Nope');
    expect(current().updateErrorFor(other)).toBeNull();
    expect(current().updateErrorFor()).toBe('Nope');

    act(() => current().clearUpdateError());
    expect(current().updateErrorFor(skill)).toBeNull();
  });
  it('blocks explicit requests while a background check is pending', () => {
    const skill = makeSkill();
    const { current } = renderActions();
    emitProgress({
      operation: 'check-updates',
      status: 'running',
      message: '',
    });
    act(() => {
      current().checkUpdates();
      current().applyUpdate(skill);
    });
    expect(checkUpdates).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
  });

  it('keeps applying visible when background progress arrives during apply', () => {
    updateSkill.mockReturnValueOnce(deferred<{ success: boolean }>().promise);
    const { current } = renderActions();
    act(() => current().applyUpdate(makeSkill()));
    emitProgress({
      operation: 'check-updates',
      status: 'running',
      message: '',
    });
    expect(current().updatePending).toBe('applying');
  });

  it('refreshes all inventories after an explicit check even without progress', async () => {
    const onSkillsChanged = jest.fn(() => Promise.resolve());
    checkUpdates.mockResolvedValueOnce({ success: true, data: {} });
    const { current } = renderActions({ onSkillsChanged });
    act(() => current().checkUpdates());
    await flush();
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });

  it('does not attribute overlapping progress to the newest running event', async () => {
    const skill = makeSkill({ updateAvailable: true });
    const observer = renderActions();
    const applying = renderActions();
    const apply = deferred<{ success: boolean }>();
    updateSkill.mockReturnValueOnce(apply.promise);
    act(() => applying.current().applyUpdate(skill));
    emitProgress({
      operation: 'check-updates',
      status: 'running',
      message: '',
    });
    await act(async () => {
      apply.resolve({ success: true });
      await Promise.resolve();
    });
    await flush();
    emitProgress({
      operation: 'check-updates',
      status: 'running',
      message: '',
    });
    emitProgress({
      operation: 'check-updates',
      status: 'complete',
      message: '',
      updateMap: { [keyOf(skill)]: true },
    });
    expect(observer.current().updateAvailable(skill)).toBe(false);
    expect(observer.current().updatePending).toBe('checking');
    emitProgress({
      operation: 'check-updates',
      status: 'complete',
      message: '',
      updateMap: { [keyOf(skill)]: false },
    });
    expect(observer.current().updatePending).toBe('none');
  });
  it('accepts explicit false progress without its start while protecting a newer apply', async () => {
    const skill = makeSkill();
    const { current } = renderActions();
    checkUpdates.mockResolvedValueOnce({
      success: true,
      data: { [keyOf(skill)]: true },
    });
    act(() => current().checkUpdates());
    await flush();
    expect(current().updateAvailable(skill)).toBe(true);
    emitProgress({
      operation: 'check-updates',
      status: 'complete',
      message: '',
      updateMap: { [keyOf(skill)]: false },
    });
    expect(current().updateAvailable(skill)).toBe(false);
    updateSkill.mockResolvedValueOnce({ success: true });
    act(() => current().applyUpdate(skill));
    await flush();
    emitProgress({
      operation: 'check-updates',
      status: 'complete',
      message: '',
      updateMap: { [keyOf(skill)]: true },
    });
    expect(current().updateAvailable(skill)).toBe(false);
  });
});
