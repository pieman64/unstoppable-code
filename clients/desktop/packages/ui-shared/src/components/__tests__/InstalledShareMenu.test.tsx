/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InstalledShareMenu } from '../InstalledShareMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const activeRoots: Root[] = [];

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  act(() => {
    root.render(node);
  });
  return root;
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(id: string): void {
  const el = byTestId(id);
  if (!el) throw new Error(`${id} not found`);
  act(() => {
    el.click();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    while (activeRoots.length > 0) activeRoots.pop()?.unmount();
  });
  document.body.innerHTML = '';
});

describe('InstalledShareMenu', () => {
  it('opens and closes the menu from the kebab', () => {
    render(<InstalledShareMenu onManage={jest.fn()} />);
    expect(byTestId('installed-share-menu')).toBeNull();
    click('installed-share-kebab');
    expect(byTestId('installed-share-menu')).not.toBeNull();
    expect(
      byTestId('installed-share-kebab')?.getAttribute('aria-expanded'),
    ).toBe('true');
    click('installed-share-kebab');
    expect(byTestId('installed-share-menu')).toBeNull();
  });

  it('closes on an outside pointer-down and on Escape', () => {
    render(<InstalledShareMenu onManage={jest.fn()} />);
    click('installed-share-kebab');
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(byTestId('installed-share-menu')).toBeNull();

    click('installed-share-kebab');
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(byTestId('installed-share-menu')).toBeNull();
  });

  it('runs Manage and closes the menu', () => {
    const onManage = jest.fn();
    render(
      <InstalledShareMenu
        onManage={onManage}
        manageLabel="Manage in the app"
      />,
    );
    click('installed-share-kebab');
    expect(byTestId('installed-share-manage')?.textContent).toBe(
      'Manage in the app',
    );
    click('installed-share-manage');
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(byTestId('installed-share-menu')).toBeNull();
  });

  it('leads every row with an icon and keeps Uninstall in its own last group', () => {
    render(
      <InstalledShareMenu
        onManage={jest.fn()}
        onUninstall={() => Promise.resolve(true)}
      />,
    );
    click('installed-share-kebab');
    const kebab = byTestId('installed-share-kebab');
    expect(kebab?.querySelector('svg')).toBeInstanceOf(Element);
    expect(kebab?.textContent).toBe('');
    const menu = byTestId('installed-share-menu');
    const rows = Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'installed-share-manage',
      'installed-share-uninstall',
    ]);
    for (const row of rows) {
      expect(row.querySelector('svg')).not.toBeNull();
    }
    const separators = menu?.querySelectorAll('[role="separator"]') ?? [];
    expect(separators).toHaveLength(1);
    expect(separators[0]?.nextElementSibling).toBe(rows[1]);
    expect(rows[1]?.className).toContain('fg-destructive');
  });

  it('offers Manage only when there is nothing to uninstall', () => {
    render(<InstalledShareMenu onManage={jest.fn()} />);
    click('installed-share-kebab');
    expect(byTestId('installed-share-uninstall')).toBeNull();
  });

  it('confirms Uninstall in a dialog named for the outcome, never Yes or No', async () => {
    const onUninstall = jest.fn(() => Promise.resolve(true));
    render(
      <InstalledShareMenu
        uninstallTitle="Uninstall this skill?"
        onManage={jest.fn()}
        onUninstall={onUninstall}
      />,
    );
    click('installed-share-kebab');
    click('installed-share-uninstall');
    const dialog = byTestId('installed-share-uninstall-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Uninstall this skill?');
    expect(dialog?.textContent).not.toMatch(/\bYes\b|\bNo\b/);
    // The same menu serves share links and in-app installs, so the copy
    // never assumes the user arrived from a link.
    expect(dialog?.textContent).toContain(
      'This removes your installed copy. You can install it again later.',
    );
    expect(onUninstall).not.toHaveBeenCalled();

    click('installed-share-uninstall-confirm');
    await flush();
    expect(onUninstall).toHaveBeenCalledTimes(1);
    expect(byTestId('installed-share-uninstall-dialog')).toBeNull();
  });

  it('keeps the confirm open with an error when nothing was removed', async () => {
    render(
      <InstalledShareMenu
        onManage={jest.fn()}
        onUninstall={() => Promise.resolve(false)}
      />,
    );
    click('installed-share-kebab');
    click('installed-share-uninstall');
    click('installed-share-uninstall-confirm');
    await flush();
    expect(byTestId('installed-share-uninstall-dialog')).not.toBeNull();
    expect(byTestId('confirm-dialog-error')?.textContent).toBe(
      'Could not uninstall. Try again.',
    );
  });

  it('treats a rejected uninstall as a failure', async () => {
    render(
      <InstalledShareMenu
        onManage={jest.fn()}
        onUninstall={() => Promise.reject(new Error('boom'))}
      />,
    );
    click('installed-share-kebab');
    click('installed-share-uninstall');
    click('installed-share-uninstall-confirm');
    await flush();
    expect(byTestId('confirm-dialog-error')).not.toBeNull();
  });

  it('disables the kebab while the host is busy', () => {
    render(<InstalledShareMenu onManage={jest.fn()} busy />);
    const kebab = byTestId('installed-share-kebab');
    expect(kebab instanceof HTMLButtonElement && kebab.disabled).toBe(true);
  });

  it('accepts host test ids', () => {
    render(
      <InstalledShareMenu
        onManage={jest.fn()}
        testIds={{
          kebab: 'share-installed-kebab',
          menu: 'share-installed-menu',
        }}
      />,
    );
    click('share-installed-kebab');
    expect(byTestId('share-installed-menu')).not.toBeNull();
  });
});
