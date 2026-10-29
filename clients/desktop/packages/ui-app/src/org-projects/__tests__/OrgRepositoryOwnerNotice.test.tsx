/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  OrgRepositoryOwnerNotice,
  orgRepositoryOwnerNoticeCopy,
  orgRepositoryOwnerSwitchFailure,
  type OrgRepositoryOwnerNoticeProps,
} from '../OrgRepositoryOwnerNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('OrgRepositoryOwnerNotice', () => {
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

  function render(props: Partial<OrgRepositoryOwnerNoticeProps> = {}): {
    add: jest.Mock;
    proceed: jest.Mock;
  } {
    const add = jest.fn();
    const proceed = jest.fn();
    act(() => {
      root.render(
        <OrgRepositoryOwnerNotice
          repositoryName="acme/payments"
          organizationName="Acme"
          currentScopeName="Personal"
          onAddToOrganization={add}
          onContinue={proceed}
          {...props}
        />,
      );
    });
    return { add, proceed };
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('builds the shared copy for the current scope', () => {
    expect(
      orgRepositoryOwnerNoticeCopy({
        repositoryName: 'acme/payments',
        organizationName: 'Acme',
        currentScopeName: 'Personal',
      }),
    ).toEqual({
      title: 'Acme has set up acme/payments.',
      message:
        'Adding it to Personal leaves out its skills, connectors and shared settings.',
      addLabel: 'Add to Acme',
      continueLabel: 'Add to Personal',
    });
    expect(
      orgRepositoryOwnerNoticeCopy({
        repositoryName: 'acme/payments',
        organizationName: 'Acme',
        currentScopeName: 'Beta',
      }).continueLabel,
    ).toBe('Add to Beta');
  });

  it('builds the one switch-failure sentence both hosts show', () => {
    expect(orgRepositoryOwnerSwitchFailure('Acme')).toBe(
      "Couldn't switch to Acme. Try again.",
    );
  });

  it('warns what adding elsewhere leaves out, with one primary action', () => {
    render();
    const notice = byTestId('add-workspace-org-owner-notice');
    expect(notice?.textContent).toContain(
      'Acme has set up acme/payments. Adding it to Personal leaves out its skills, connectors and shared settings.',
    );
    // Both choices stay open, but adding elsewhere loses the setup (CAN-3909).
    expect(notice?.getAttribute('data-notice-intent')).toBe('attention');
    const add = byTestId('add-workspace-org-owner-notice-add');
    const proceed = byTestId('add-workspace-org-owner-notice-continue');
    expect(add?.textContent).toBe('Add to Acme');
    expect(proceed?.textContent).toBe('Add to Personal');
    // The recommended action is the only accent one and comes last.
    expect(add?.className).toContain('bg-accent');
    expect(proceed?.className).not.toContain('bg-accent');
    const buttons = Array.from(notice?.querySelectorAll('button') ?? []);
    expect(buttons.at(-1)).toBe(add);
  });

  it('hands each choice to the host', () => {
    const { add, proceed } = render();
    act(() => byTestId('add-workspace-org-owner-notice-add')?.click());
    act(() => byTestId('add-workspace-org-owner-notice-continue')?.click());
    expect(add).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('disables both choices while one is pending', () => {
    render({ pending: true });
    for (const id of [
      'add-workspace-org-owner-notice-add',
      'add-workspace-org-owner-notice-continue',
    ]) {
      const button = byTestId(id);
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
    }
  });
});
