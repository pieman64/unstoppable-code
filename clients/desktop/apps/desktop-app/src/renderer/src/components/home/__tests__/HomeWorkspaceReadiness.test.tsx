/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { HomeWorkspaceReadiness } from '../HomeWorkspaceReadiness';
import { launchWorkspaceReadinessFix } from '@/lib/workspaceReadinessLauncher';

jest.mock('@/lib/workspaceReadinessLauncher', () => ({
  launchWorkspaceReadinessFix: jest.fn(),
}));
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const issue: WorkspaceReadinessIssue = {
  code: 'configure-hooks',
  title: 'Add repository hooks',
  message: 'Configure hooks',
  repoName: 'Example',
  fixPrompt: 'Add hooks',
};
let root: Root;
let container: HTMLDivElement;
const read = jest.fn();
beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorkspaceReadiness: read },
  });
  read.mockResolvedValue({
    issues: [
      issue,
      {
        ...issue,
        code: 'recovery-required',
        title: 'Recover interrupted creation',
        fixPrompt: null,
      },
    ],
  });
});
afterEach(() => {
  act(() => root.unmount());
  jest.resetAllMocks();
  Reflect.deleteProperty(window, 'api');
});

it('retains actionable fixes without turning recovery evidence into an automatic action', async () => {
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
    await Promise.resolve();
  });
  expect(read).toHaveBeenCalledWith({ workspaceId: 'selected-project' });
  expect(container.textContent).toContain('Add repository hooks');
  expect(container.textContent).not.toContain('Recover interrupted creation');
});

it('deduplicates fix dispatch and removes the row only after acceptance', async () => {
  let resolve:
    | ((value: { ok: true; worktreeId: string; chatId: string }) => void)
    | undefined;
  jest.mocked(launchWorkspaceReadinessFix).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
    await Promise.resolve();
  });
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid^="home-readiness-fix-"]',
  );
  act(() => {
    button?.click();
    button?.click();
  });
  expect(launchWorkspaceReadinessFix).toHaveBeenCalledTimes(1);
  expect(launchWorkspaceReadinessFix).toHaveBeenCalledWith(
    'selected-project',
    issue,
  );
  expect(container.textContent).toContain('Add repository hooks');
  await act(async () => {
    resolve?.({ ok: true, worktreeId: 'wt', chatId: 'chat' });
    await Promise.resolve();
  });
  expect(container.childElementCount).toBe(0);
});

it('keeps a rejected fix available for retry with its error', async () => {
  jest
    .mocked(launchWorkspaceReadinessFix)
    .mockResolvedValue({ ok: false, message: 'Try again' });
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
    await Promise.resolve();
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid^="home-readiness-fix-"]')
      ?.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Try again',
  );
  expect(
    container.querySelector<HTMLButtonElement>(
      '[data-testid^="home-readiness-fix-"]',
    )?.disabled,
  ).toBe(false);
});

it('ignores a read completing after the selected project changed', async () => {
  let resolveOld:
    | ((value: { issues: WorkspaceReadinessIssue[] }) => void)
    | undefined;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveOld = done;
      }),
  );
  await act(async () => {
    root.render(<HomeWorkspaceReadiness key="old" workspaceId="old" />);
    await Promise.resolve();
  });
  read.mockResolvedValueOnce({ issues: [] });
  await act(async () => {
    root.render(<HomeWorkspaceReadiness key="new" workspaceId="new" />);
    await Promise.resolve();
  });
  await act(async () => {
    resolveOld?.({ issues: [issue] });
    await Promise.resolve();
  });
  expect(container.childElementCount).toBe(0);
});
