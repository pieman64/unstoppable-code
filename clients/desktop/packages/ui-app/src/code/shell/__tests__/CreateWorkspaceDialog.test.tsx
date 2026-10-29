/** @jest-environment jsdom */
import { act } from 'react';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceCreateResult } from '@canopy/app-core';
import { CreateWorkspaceDialog } from '../CreateWorkspaceDialog';

function changeInput(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="remote-url"]',
  );
  if (!input) throw new Error('remote URL input not found');
  const setter = Reflect.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    if (setter) Reflect.apply(setter, input, [value]);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CreateWorkspaceDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    { status: 'pending' as const },
    { status: 'completed' as const, workspaceId: 'workspace-1' },
  ])('closes for a $status result', async (result) => {
    const onCreate = jest.fn().mockResolvedValue(result);
    const onClose = jest.fn();
    act(() => {
      root.render(
        <CreateWorkspaceDialog
          mode="remote-clone"
          onCreate={onCreate}
          onClose={onClose}
          testIds={{ remoteUrl: 'remote-url', submit: 'submit' }}
        />,
      );
    });
    changeInput('  https://example.com/repo.git  ');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="submit"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith({
      kind: 'remote-clone',
      remoteUrl: 'https://example.com/repo.git',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not submit a blank URL', async (): Promise<void> => {
    const onCreate = jest.fn(
      (): Promise<WorkspaceCreateResult> =>
        Promise.resolve({ status: 'pending' }),
    );
    const onClose = jest.fn();
    act(() => {
      root.render(
        <CreateWorkspaceDialog
          mode="remote-clone"
          onCreate={onCreate}
          onClose={onClose}
          testIds={{ remoteUrl: 'remote-url', submit: 'submit' }}
        />,
      );
    });
    const submit = document.querySelector('[data-testid="submit"]');
    if (!(submit instanceof HTMLButtonElement)) {
      throw new Error('submit button not found');
    }
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('shows a Cloning… pending state while the create is in flight', async (): Promise<void> => {
    let resolveCreate: (outcome: WorkspaceCreateResult) => void = () =>
      undefined;
    const onCreate = jest.fn(
      (): Promise<WorkspaceCreateResult> =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    act(() => {
      root.render(
        <CreateWorkspaceDialog
          mode="remote-clone"
          onCreate={onCreate}
          onClose={jest.fn()}
          testIds={{ remoteUrl: 'remote-url', submit: 'submit' }}
        />,
      );
    });
    changeInput('https://github.com/org/repo.git');
    const submit = document.querySelector('[data-testid="submit"]');
    if (!(submit instanceof HTMLButtonElement)) {
      throw new Error('submit button not found');
    }
    // Keep the host promise pending so the in-flight label remains observable.
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    expect(submit.textContent).toContain('Cloning');
    expect(submit.disabled).toBe(true);

    await act(async () => {
      resolveCreate({ status: 'pending' });
      await Promise.resolve();
    });
  });

  it('stays open and presents a rejected command', async () => {
    const onCreate = jest.fn().mockRejectedValue(new Error('Clone denied'));
    const onClose = jest.fn();
    act(() => {
      root.render(
        <CreateWorkspaceDialog
          mode="remote-clone"
          onCreate={onCreate}
          onClose={onClose}
          testIds={{
            dialog: 'dialog',
            remoteUrl: 'remote-url',
            submit: 'submit',
            error: 'error',
          }}
        />,
      );
    });
    changeInput('  https://github.com/cursor/plugins/tree/main/pstack  ');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="submit"]')
        ?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe(
      "Couldn't confirm that the clone finished. Check Projects before trying again.",
    );
    expect(onCreate).toHaveBeenCalledWith({
      kind: 'remote-clone',
      remoteUrl: 'https://github.com/cursor/plugins',
    });
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="remote-url"]')
        ?.value,
    ).toBe('  https://github.com/cursor/plugins/tree/main/pstack  ');
    expect(
      document
        .querySelector<HTMLInputElement>('[data-testid="remote-url"]')
        ?.getAttribute('aria-describedby'),
    ).toBe('error');
    expect(
      document.querySelector('[data-testid="error"]')?.getAttribute('role'),
    ).toBe('alert');
    expect(onClose).not.toHaveBeenCalled();
  });
});
