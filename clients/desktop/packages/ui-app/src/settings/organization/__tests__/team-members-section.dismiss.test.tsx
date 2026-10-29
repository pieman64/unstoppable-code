/**
 * @jest-environment jsdom
 */
// CAN-4558 (G): the Add member dialog has no Cancel button. It closes from the
// DialogModal X, Escape, or a backdrop click. Cancel was never disabled while
// an invite was in flight, so each of those must still close the dialog
// mid-submit.

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamMembersSection } from '../team-members-section';
import {
  buildOrganizationDetail,
  OrganizationTestHost,
} from './helpers/members-section-harness';

type Dismissal = 'close button' | 'Escape' | 'backdrop';

const DISMISSALS: readonly Dismissal[] = ['close button', 'Escape', 'backdrop'];

let container: HTMLDivElement;
let root: Root | null = null;
let client: FakeSettingsClient;
let onAddingChange: jest.Mock;

beforeEach(() => {
  onAddingChange = jest.fn();
  client = createFakeSettingsClient({
    'organization.invitations.list': () => ({ enabled: true, invites: [] }),
    // Never settles, so the dialog stays in its submitting state.
    'organization.members.invite': () => new Promise<never>(() => {}),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

async function settle(): Promise<void> {
  // The dialog schedules its quote load on a macrotask.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireElement(testId: string): HTMLElement {
  const found = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`${testId} was not rendered`);
  }
  return found;
}

async function mount(): Promise<void> {
  // No seat-charge slot: the dialog starts on its free path, ready to submit.
  await act(async () => {
    root = createRoot(container);
    root.render(
      <OrganizationTestHost client={client}>
        <TeamMembersSection
          detail={buildOrganizationDetail()}
          viewerEmail="owner@example.com"
          onDetailChange={jest.fn()}
          onLeft={jest.fn()}
          adding
          onAddingChange={onAddingChange}
        />
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
  await settle();
}

function typeEmail(value: string): void {
  const input = requireElement('add-member-email');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('add-member-email is not an input');
  }
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dismiss(how: Dismissal): void {
  const dialog = requireElement('add-member-dialog');
  act(() => {
    if (how === 'close button') {
      const close = dialog.querySelector('button[aria-label="Close"]');
      if (!(close instanceof HTMLButtonElement)) {
        throw new Error('Close button was not rendered');
      }
      close.click();
    } else if (how === 'Escape') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      const backdrop = dialog.parentElement;
      if (!(backdrop instanceof HTMLElement)) {
        throw new Error('Backdrop was not rendered');
      }
      backdrop.click();
    }
  });
}

it('has no Cancel button', async () => {
  await mount();
  const labels = Array.from(
    requireElement('add-member-dialog').querySelectorAll('button'),
    (button) => button.textContent?.trim(),
  );
  expect(labels).not.toContain('Cancel');
});

it.each(DISMISSALS)('closes from the %s', async (how) => {
  await mount();
  dismiss(how);
  expect(onAddingChange).toHaveBeenCalledTimes(1);
  expect(onAddingChange).toHaveBeenCalledWith(false);
});

it.each(DISMISSALS)(
  'closes from the %s while an invite is in flight',
  async (how) => {
    await mount();
    act(() => typeEmail('new@example.com'));
    const form = requireElement('add-member-submit').closest('form');
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('add-member-submit is not inside a form');
    }
    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await settle();
    const submit = requireElement('add-member-submit');
    expect(submit.textContent).toBe('Adding…');
    expect(submit).toHaveProperty('disabled', true);
    expect(client.calls.map((call) => call.operation)).toContain(
      'organization.members.invite',
    );

    dismiss(how);
    expect(onAddingChange).toHaveBeenCalledTimes(1);
    expect(onAddingChange).toHaveBeenCalledWith(false);
  },
);
