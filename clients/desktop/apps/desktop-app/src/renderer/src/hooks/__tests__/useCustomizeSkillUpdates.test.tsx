/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { buildInstalledSkillEntry } from '@canopy/ui-app/capability';
import { useCustomizeSkillUpdates } from '../useCustomizeSkillUpdates';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it('uses list updates immediately and fences completed updates from late checks and a failed refresh', async () => {
  let finishCheck: (result: {
    success: boolean;
    data: Record<string, boolean>;
  }) => void = () => {};
  const checkUpdates = jest.fn(
    () =>
      new Promise<{ success: boolean; data: Record<string, boolean> }>(
        (resolve) => {
          finishCheck = resolve;
        },
      ),
  );
  const updateSkill = jest.fn(() => Promise.resolve({ success: true }));
  Object.defineProperty(window, 'skills', {
    configurable: true,
    value: { checkUpdates, updateSkill },
  });
  const refresh = jest.fn(() => Promise.reject(new Error('refresh offline')));
  let state: ReturnType<typeof useCustomizeSkillUpdates> | undefined;
  function Harness(): null {
    state = useCustomizeSkillUpdates(refresh);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const entry = buildInstalledSkillEntry({
    name: 'example',
    sourceId: 'github:me:repo',
    description: '',
    builtIn: false,
    updateAvailable: true,
  });
  try {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(state?.project(entry).updateAvailable).toBe(true);
    await act(async () => {
      await state?.update(entry);
    });
    expect(updateSkill).toHaveBeenCalledWith('github:me:repo', 'example');
    expect(state?.project(entry).updateAvailable).toBe(false);
    expect(state?.error).toContain('Updated the skill');
    await act(async () => {
      finishCheck({ success: true, data: { 'github:me:repo/example': true } });
      await Promise.resolve();
    });
    expect(state?.project(entry).updateAvailable).toBe(false);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(checkUpdates).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});

it('surfaces rejected and unsuccessful mutations while a background check failure preserves list flags', async () => {
  const updateSkill = jest
    .fn()
    .mockRejectedValueOnce(new Error('IPC failed'))
    .mockResolvedValueOnce({ success: false, error: 'Couldn’t save' });
  Object.defineProperty(window, 'skills', {
    configurable: true,
    value: {
      checkUpdates: () => Promise.reject(new Error('offline')),
      updateSkill,
    },
  });
  const refresh = jest.fn(() => Promise.resolve());
  let state: ReturnType<typeof useCustomizeSkillUpdates> | undefined;
  function Harness(): null {
    state = useCustomizeSkillUpdates(refresh);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const entry = buildInstalledSkillEntry({
    name: 'example',
    sourceId: 'github:me:repo',
    description: '',
    builtIn: false,
    updateAvailable: true,
  });
  try {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await expect(state?.update(entry)).rejects.toThrow('IPC failed');
    await expect(state?.update(entry)).rejects.toThrow('Couldn’t save');
    expect(state?.project(entry).updateAvailable).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
