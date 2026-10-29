/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShareInstallDialog } from '../ShareInstallDialog';

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

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}

function closeButton(): HTMLButtonElement {
  const dialog = byTestId('share-install-dialog');
  const button = dialog?.querySelector<HTMLButtonElement>(
    'button[aria-label="Close"]',
  );
  if (!button) throw new Error('close button not found');
  return button;
}

afterEach(() => {
  act(() => {
    while (activeRoots.length > 0) activeRoots.pop()?.unmount();
  });
  document.body.innerHTML = '';
});

describe('ShareInstallDialog', () => {
  it('shows the name, type, publisher, clamped description and one primary', () => {
    const onClick = jest.fn();
    render(
      <ShareInstallDialog
        title="Release notes"
        typeLabel="Skill"
        publisher="Shared by ada"
        description="Writes release notes."
        primary={{ label: 'Install', onClick }}
        onClose={jest.fn()}
      />,
    );
    const dialog = byTestId('share-install-dialog');
    expect(dialog?.textContent).toContain('Release notes');
    expect(byTestId('share-install-type-label')?.textContent).toBe('Skill');
    expect(dialog?.textContent).toContain('Shared by ada');
    const description = byTestId('share-install-description');
    expect(description?.textContent).toBe('Writes release notes.');
    expect(description?.className).toContain('line-clamp-3');
    const buttons = Array.from(dialog?.querySelectorAll('button') ?? []).map(
      (button) => button.textContent,
    );
    expect(buttons).not.toContain('Cancel');
    act(() => {
      byTestId('share-install-primary')?.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('closes from Escape and the close button when idle', () => {
    const onClose = jest.fn();
    render(<ShareInstallDialog title="Shared skill" onClose={onClose} />);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      closeButton().click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores every close affordance while busy', () => {
    const onClose = jest.fn();
    render(
      <ShareInstallDialog
        title="Release notes"
        busy
        primary={{
          label: 'Install',
          onClick: jest.fn(),
          busy: true,
          spinnerTestId: 'share-install-primary-spinner',
        }}
        onClose={onClose}
      />,
    );
    expect(
      byTestId('share-install-primary')?.querySelector(
        '[data-testid="share-install-primary-spinner"]',
      ),
    ).not.toBeNull();
    pressEscape();
    expect(closeButton().disabled).toBe(true);
    act(() => {
      closeButton().click();
    });
    expect(onClose).not.toHaveBeenCalled();
    const primary = byTestId('share-install-primary');
    expect(primary instanceof HTMLButtonElement && primary.disabled).toBe(true);
  });

  it('renders inputs, a blocker line and a disabled primary', () => {
    render(
      <ShareInstallDialog
        title="Nightly triage"
        inputs={<span>Choose a project</span>}
        blocker="Couldn't reach the server."
        primary={{ label: 'Install', onClick: jest.fn(), disabled: true }}
        onClose={jest.fn()}
      />,
    );
    expect(byTestId('share-install-inputs')?.textContent).toBe(
      'Choose a project',
    );
    expect(byTestId('share-install-blocker')?.textContent).toBe(
      "Couldn't reach the server.",
    );
    const primary = byTestId('share-install-primary');
    expect(primary instanceof HTMLButtonElement && primary.disabled).toBe(true);
  });

  it('omits the action row when there is nothing to do', () => {
    render(
      <ShareInstallDialog
        title="Shared skill"
        blocker="This share is no longer available."
        onClose={jest.fn()}
      />,
    );
    expect(byTestId('share-install-primary')).toBeNull();
  });
});
