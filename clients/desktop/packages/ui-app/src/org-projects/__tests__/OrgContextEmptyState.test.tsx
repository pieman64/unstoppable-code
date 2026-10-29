/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  OrgContextEmptyState,
  type OrgContextEmptyStateProps,
} from '../OrgContextEmptyState';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('OrgContextEmptyState', () => {
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

  function render(props: Partial<OrgContextEmptyStateProps> = {}): void {
    act(() => {
      root.render(<OrgContextEmptyState organizationName="Acme" {...props} />);
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  const planMissing = {
    title: 'Acme has no active plan',
    subtitle: 'Choose a plan to use projects and chats here.',
  };

  /** The copy and the sidebar way out that CAN-3550 removed. */
  function expectNoRetiredCopy(): void {
    expect(container.textContent).not.toContain('Nothing in Acme yet');
    expect(container.textContent).not.toContain('Projects your admins add');
    expect(container.textContent).not.toContain('Add a project from Acme');
    expect(container.textContent).not.toContain('Add the ones you work on');
    expect(container.textContent).not.toContain('Back to Personal');
    expect(byTestId('sidebar-context-empty-state-back')).toBeNull();
  }

  it.each([false, true])(
    'shows only None found, with no action of its own (Chats listed: %s)',
    (chatsListed: boolean) => {
      render({ chatsListed });
      expect(byTestId('sidebar-context-empty-state')?.textContent).toBe(
        'None found',
      );
      expect(byTestId('sidebar-context-empty-state-label')?.textContent).toBe(
        'None found',
      );
      // The Projects header's "+" adds a project; the row repeats nothing.
      expect(byTestId('sidebar-context-empty-state-add')).toBeNull();
      expect(container.textContent).not.toContain('Add project');
      expect(
        byTestId('sidebar-context-empty-state')?.querySelector('button'),
      ).toBeNull();
      expectNoRetiredCopy();
    },
  );

  it('says why when the organization has no plan, with the host action', () => {
    const onChoosePlan = jest.fn();
    render({
      planMissing: {
        ...planMissing,
        choosePlan: { label: 'Choose a plan', onClick: onChoosePlan },
      },
    });
    expect(container.textContent).toContain('Acme has no active plan');
    expect(container.textContent).toContain(
      'Choose a plan to use projects and chats here.',
    );
    expect(container.textContent).not.toContain('None found');
    expect(byTestId('sidebar-context-empty-state-label')).toBeNull();
    expect(byTestId('sidebar-context-empty-state-add')).toBeNull();
    expect(byTestId('sidebar-context-empty-state-back')).toBeNull();
    expect(container.textContent).not.toContain('Back to Personal');
    act(() => byTestId('sidebar-context-empty-state-choose-plan')?.click());
    expect(onChoosePlan).toHaveBeenCalledTimes(1);
  });

  it('explains a missing plan to someone who cannot choose one, with no action', () => {
    render({ planMissing });
    expect(container.textContent).toContain('Acme has no active plan');
    expect(byTestId('sidebar-context-empty-state-choose-plan')).toBeNull();
    expect(byTestId('sidebar-context-empty-state-back')).toBeNull();
    expect(
      byTestId('sidebar-context-empty-state')?.querySelector('button'),
    ).toBe(null);
  });

  it('stays out of the way when a plan is missing under a listed Chats section', () => {
    render({ planMissing, chatsListed: true });
    expect(byTestId('sidebar-context-empty-state')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
