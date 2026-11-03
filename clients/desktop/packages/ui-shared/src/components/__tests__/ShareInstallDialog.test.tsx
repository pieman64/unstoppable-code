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
    expect(primary?.getAttribute('aria-disabled')).toBe('true');
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

  it('renders the effect line under the description, and nothing when empty', () => {
    render(
      <ShareInstallDialog
        title="Release notes"
        typeLabel="Skill"
        publisher="Shared by ada"
        description="Writes release notes."
        effect="Adds a copy to this device."
        primary={{ label: 'Install', onClick: jest.fn() }}
        onClose={jest.fn()}
      />,
    );
    expect(byTestId('share-install-publisher')?.textContent).toBe(
      'Shared by ada',
    );
    const effect = byTestId('share-install-effect');
    expect(effect?.textContent).toBe('Adds a copy to this device.');
    const description = byTestId('share-install-description');
    expect(
      description !== null &&
        effect !== null &&
        description.compareDocumentPosition(effect) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([undefined, ''])('renders no effect paragraph for %p', (effect) => {
    render(
      <ShareInstallDialog
        title="Release notes"
        {...(effect !== undefined ? { effect } : {})}
        onClose={jest.fn()}
      />,
    );
    expect(byTestId('share-install-effect')).toBeNull();
    expect(byTestId('share-install-publisher')).toBeNull();
  });
});

describe('ShareInstallDialog focus', () => {
  function pressTab(shiftKey = false): void {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }),
      );
    });
  }

  function renderWithOpener(node: JSX.Element): {
    opener: HTMLButtonElement;
    root: Root;
  } {
    const opener = document.createElement('button');
    opener.textContent = 'Open review';
    document.body.appendChild(opener);
    opener.focus();
    return { opener, root: render(node) };
  }

  function review(
    overrides: Partial<Parameters<typeof ShareInstallDialog>[0]> = {},
  ): JSX.Element {
    return (
      <ShareInstallDialog
        title="Release notes"
        typeLabel="Skill"
        publisher="Shared by ada"
        primary={{ label: 'Install', onClick: jest.fn() }}
        onClose={jest.fn()}
        {...overrides}
      />
    );
  }

  it('starts on the close button, never the primary', () => {
    renderWithOpener(review());
    expect(document.activeElement).toBe(closeButton());
  });

  it('keeps Tab and Shift+Tab inside the review', () => {
    renderWithOpener(review());
    const primary = byTestId('share-install-primary');
    pressTab(true);
    expect(document.activeElement).toBe(primary);
    pressTab();
    expect(document.activeElement).toBe(closeButton());
  });

  it('returns focus to an opener that is still mounted', () => {
    const { opener, root } = renderWithOpener(review());
    expect(document.activeElement).not.toBe(opener);
    act(() => {
      root.unmount();
    });
    activeRoots.splice(activeRoots.indexOf(root), 1);
    expect(document.activeElement).toBe(opener);
  });

  it('falls back to the page when the opener is gone', () => {
    const { opener, root } = renderWithOpener(review());
    opener.remove();
    act(() => {
      root.unmount();
    });
    activeRoots.splice(activeRoots.indexOf(root), 1);
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps focus inside the review when the focused primary turns busy', () => {
    const onClick = jest.fn();
    const root = renderWithOpener(
      review({ primary: { label: 'Install', onClick } }),
    ).root;
    const primary = byTestId('share-install-primary');
    primary?.focus();
    expect(document.activeElement).toBe(primary);
    act(() => {
      root.render(
        review({
          busy: true,
          primary: { label: 'Install', onClick, busy: true },
        }),
      );
    });
    const dialog = byTestId('share-install-dialog');
    const active = document.activeElement;
    expect(active !== null && dialog?.contains(active)).toBe(true);
    expect(active?.hasAttribute('disabled')).toBe(false);
    // A second activation while busy cannot start another install.
    act(() => {
      byTestId('share-install-primary')?.click();
    });
    expect(onClick).not.toHaveBeenCalled();
    pressTab();
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });

  it('traps focus for a non-skill review too', () => {
    renderWithOpener(review({ typeLabel: 'Automation', publisher: undefined }));
    expect(document.activeElement).toBe(closeButton());
    pressTab(true);
    expect(document.activeElement).toBe(byTestId('share-install-primary'));
  });

  it.each(['disabled', 'loading'] as const)(
    'keeps focus inside when a focused primary becomes %s',
    (transition) => {
      const root = renderWithOpener(review()).root;
      byTestId('share-install-primary')?.focus();
      act(() => {
        root.render(
          review(
            transition === 'loading'
              ? { primary: undefined, loading: <span>Loading…</span> }
              : {
                  primary: {
                    label: 'Install',
                    onClick: jest.fn(),
                    disabled: true,
                  },
                },
          ),
        );
      });
      expect(
        byTestId('share-install-dialog')?.contains(document.activeElement),
      ).toBe(true);
      // The fallback must be a Tab stop when one exists. A negative-tabindex
      // body after the close button would let native forward Tab leave it.
      expect(document.activeElement).toBe(closeButton());
      pressTab(true);
      expect(
        byTestId('share-install-dialog')?.contains(document.activeElement),
      ).toBe(true);
    },
  );
});
