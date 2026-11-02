/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import type * as ReactModule from 'react';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { SkillUpdateAction } from '@canopy/ui-shared/lib';

interface ModalProps {
  skill: { sourceId: string; name: string };
  updateAction?: SkillUpdateAction;
  loadErrorPrefix?: string;
  notice?: ReactNode;
}

let modalProps: ModalProps | null = null;
const modalMounts = jest.fn();
const readProvenance = jest.fn();
jest.mock('../useInstalledShareProvenance', () => ({
  useInstalledShareProvenance: (
    skill: InstalledSkillInfo | undefined,
  ): undefined => {
    readProvenance(skill);
    return undefined;
  },
}));
jest.mock('../../pages/SkillsTab', () => {
  const { useEffect } = jest.requireActual<typeof ReactModule>('react');
  return {
    CustomSkillEditor: (): null => null,
    SkillDetailModal: (props: ModalProps): ReactElement => {
      modalProps = props;
      const { name } = props.skill;
      // Counts mounts: InstalledSkillDetail remounts the viewer to reload.
      useEffect(() => {
        modalMounts(name);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div>{props.notice}</div>;
    },
  };
});
const notifySkillsChanged = jest.fn(() => Promise.resolve());
jest.mock('@/lib/skillsChanged', () => ({
  notifySkillsChanged: (): Promise<void> => notifySkillsChanged(),
}));
jest.mock('@/lib/editSkillWithAI', () => ({
  skillDetailEditWithAIState: (): undefined => undefined,
}));
jest.mock('../useEditSkillWithAI', () => ({
  useEditSkillWithAI: (): {
    start: jest.Mock;
    pending: boolean;
    error: null;
  } => ({ start: jest.fn(), pending: false, error: null }),
}));
jest.mock('@/hooks/useWorkspaceContextReset', () => ({
  useWorkspaceContextReset: (): void => {},
}));
jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): { requestShare: jest.Mock; shareGateModal: null } => ({
    requestShare: jest.fn(),
    shareGateModal: null,
  }),
}));
jest.mock('../ShareSkillModal', () => ({ ShareSkillModal: (): null => null }));
jest.mock('../../shared', () => ({
  DeleteConfirmModal: (): null => null,
  ErrorBanner: ({ error }: { error?: string | null }): ReactElement | null =>
    error ? <p role="alert">{error}</p> : null,
}));

import { InstalledSkillDetail } from '../InstalledSkillDetail';

let skillCounter = 0;
function makeSkill(
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo {
  skillCounter += 1;
  return {
    name: `detail-skill-${skillCounter}`,
    description: 'A skill',
    sourceId: 'github:owner:repo',
    source: 'owner/repo',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    ...overrides,
  };
}

const checkUpdates = jest.fn();
const updateSkill = jest.fn();
let root: Root;
let container: HTMLDivElement;

function render(
  installedSkill: InstalledSkillInfo | undefined,
  editing = false,
): void {
  const skill = installedSkill ?? makeSkill();
  act(() =>
    root.render(
      <InstalledSkillDetail
        skill={{ sourceId: skill.sourceId, name: skill.name }}
        installedSkill={installedSkill}
        presentation="page"
        editing={editing}
        onClose={() => {}}
      />,
    ),
  );
}

function action(): SkillUpdateAction | undefined {
  return modalProps?.updateAction;
}

function ready(): Extract<SkillUpdateAction, { status: 'ready' }> {
  const current = action();
  if (current?.status !== 'ready') throw new Error('no ready update action');
  return current;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  modalProps = null;
  modalMounts.mockClear();
  notifySkillsChanged.mockClear();
  checkUpdates.mockReset();
  updateSkill.mockReset();
  readProvenance.mockClear();
  Object.assign(window, {
    skills: {
      checkUpdates,
      updateSkill,
      onUpdateProgress: (): (() => void) => () => {},
    },
  });
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('InstalledSkillDetail updates (CAN-4264)', () => {
  it('suspends provenance while editing and reopens it when returning to the detail', () => {
    const skill = makeSkill({
      sourceId: 'custom:app',
      custom: true,
      installedFromShare: { remoteId: 'shared-1' },
    });
    render(skill);
    expect(readProvenance).toHaveBeenLastCalledWith(skill);
    render(skill, true);
    expect(readProvenance).toHaveBeenLastCalledWith(undefined);
    render(skill);
    expect(readProvenance).toHaveBeenLastCalledWith(skill);
  });
  it('hides the update control for missing, built-in, and custom records', () => {
    render(undefined);
    expect(action()).toBeUndefined();
    render(makeSkill({ builtIn: true, sourceId: 'builtin:app' }));
    expect(action()).toBeUndefined();
    render(makeSkill({ custom: true, sourceId: 'custom:app' }));
    expect(action()).toBeUndefined();
  });

  it('shows cached availability for an eligible install without checking', () => {
    render(makeSkill({ updateAvailable: true }));
    expect(action()).toMatchObject({
      status: 'ready',
      updateAvailable: true,
      pending: 'none',
    });
    expect(checkUpdates).not.toHaveBeenCalled();
  });

  it('checks the inventory and reads this skill from the result', async () => {
    const skill = makeSkill();
    checkUpdates.mockResolvedValueOnce({
      success: true,
      data: { [`${skill.sourceId}/${skill.name}`]: true },
    });
    render(skill);

    act(() => ready().onCheck());
    expect(action()).toMatchObject({ pending: 'checking' });
    await flush();
    expect(action()).toMatchObject({ pending: 'none', updateAvailable: true });
  });

  it('applies, refreshes inventories, and reloads the content', async () => {
    const skill = makeSkill({ updateAvailable: true });
    updateSkill.mockResolvedValueOnce({ success: true });
    render(skill);
    expect(modalMounts).toHaveBeenCalledTimes(1);

    act(() => ready().onApply());
    expect(action()).toMatchObject({ pending: 'applying' });
    await flush();

    expect(updateSkill).toHaveBeenCalledWith(skill.sourceId, skill.name);
    expect(notifySkillsChanged).toHaveBeenCalledTimes(1);
    // The remounted viewer re-reads the updated content.
    expect(modalMounts).toHaveBeenCalledTimes(2);
    expect(modalProps?.loadErrorPrefix).toContain('The skill was updated, but');
    // The stale inventory row still says true; the applied update wins.
    expect(action()).toMatchObject({ pending: 'none', updateAvailable: false });
  });

  it('does not reload another skill when an update finishes after a switch', async () => {
    const first = makeSkill({ updateAvailable: true });
    const second = makeSkill();
    let resolveUpdate: (value: { success: boolean }) => void = () => {};
    updateSkill.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    render(first);
    act(() => ready().onApply());
    render(second);
    const mountsBefore = modalMounts.mock.calls.length;

    await act(async () => {
      resolveUpdate({ success: true });
      await Promise.resolve();
    });
    await flush();

    expect(modalMounts.mock.calls.length).toBe(mountsBefore);
    expect(modalProps?.skill.name).toBe(second.name);
  });

  it('reports a failed update to the notice and clears it on another skill', async () => {
    const skill = makeSkill({ updateAvailable: true });
    updateSkill.mockResolvedValueOnce({
      success: false,
      error: 'Invalid source in lock file.',
    });
    render(skill);

    act(() => ready().onApply());
    await flush();
    expect(action()).toMatchObject({
      updateAvailable: true,
      pending: 'none',
      error: { kind: 'update-failed', detail: 'Invalid source in lock file.' },
    });
    // The update notice owns it; the page notice stays free.
    expect(container.querySelector('[role="alert"]')).toBeNull();

    render(makeSkill());
    expect(ready().error).toBeUndefined();
  });

  it('names a skill its source no longer has', async () => {
    const skill = makeSkill({ updateAvailable: true });
    updateSkill.mockResolvedValueOnce({
      success: false,
      error: `Skill "${skill.name}" no longer found in source.`,
    });
    render(skill);

    act(() => ready().onApply());
    await flush();
    expect(ready().error).toEqual({ kind: 'missing-source' });
  });

  it('reports a failed check without the generic message twice', async () => {
    checkUpdates.mockResolvedValueOnce({ success: false });
    render(makeSkill());

    act(() => ready().onCheck());
    await flush();
    expect(ready().error).toEqual({ kind: 'check-failed' });
  });

  it('keeps a failed reload after an update as the page notice', async () => {
    const skill = makeSkill({ updateAvailable: true });
    updateSkill.mockResolvedValueOnce({ success: true });
    notifySkillsChanged.mockReturnValueOnce(Promise.reject(new Error('x')));
    render(skill);

    act(() => ready().onApply());
    await flush();
    expect(ready().error).toBeUndefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'The skill was updated, but',
    );
  });

  it('records when a check completed so the page can say it is up to date', async () => {
    const skill = makeSkill();
    checkUpdates.mockResolvedValueOnce({
      success: true,
      data: { [`${skill.sourceId}/${skill.name}`]: false },
    });
    render(skill);
    const before = Date.now();

    act(() => ready().onCheck());
    await flush();
    expect(ready().checkedAt).toBeGreaterThanOrEqual(before);
  });

  it('shows an update in progress after returning and reloads when it lands', async () => {
    const first = makeSkill({ updateAvailable: true });
    let finish: (result: { success: boolean }) => void = () => {};
    updateSkill.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(first);
    act(() => ready().onApply());
    const other = makeSkill();
    render(other);
    expect(ready().pending).toBe('none');
    render(first);
    // The update started before leaving is still running.
    expect(ready().pending).toBe('applying');
    const mounts = modalMounts.mock.calls.length;
    await act(async () => {
      finish({ success: true });
      await Promise.resolve();
    });
    await flush();
    // The page shows this skill again, so it reads the updated content.
    expect(modalMounts).toHaveBeenCalledTimes(mounts + 1);
    expect(modalProps?.skill.name).toBe(first.name);
  });
});
