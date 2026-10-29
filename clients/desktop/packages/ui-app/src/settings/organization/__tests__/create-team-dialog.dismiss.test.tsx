/**
 * @jest-environment jsdom
 */
// CAN-4558 (G): the create-organization dialog has no Cancel button. It closes
// from the DialogModal X, Escape, or a backdrop click. Cancel was never
// disabled while a create was in flight, so each of those must still close
// the dialog mid-submit.

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { CreateTeamDialog } from '../create-team-dialog';

type Dismissal = 'close button' | 'Escape' | 'backdrop';

const DISMISSALS: readonly Dismissal[] = ['close button', 'Escape', 'backdrop'];

let container: HTMLDivElement;
let root: Root | null = null;
let client: FakeSettingsClient;
let onClose: jest.Mock;
let onCreated: jest.Mock;

beforeEach(() => {
  onClose = jest.fn();
  onCreated = jest.fn();
  // Never settles, so the dialog stays in its submitting state.
  client = createFakeSettingsClient({
    'organization.create': () => new Promise<never>(() => {}),
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

function requireElement(testId: string): HTMLElement {
  const found = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`${testId} was not rendered`);
  }
  return found;
}

function mount(): void {
  act(() => {
    root = createRoot(container);
    root.render(
      <TestSettingsHost host={createTestSettingsHost({ client }).host}>
        <CreateTeamDialog onClose={onClose} onCreated={onCreated} />
      </TestSettingsHost>,
    );
  });
}

function typeName(value: string): void {
  const input = requireElement('create-team-name-input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('create-team-name-input is not an input');
  }
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dismiss(how: Dismissal): void {
  const dialog = requireElement('create-team-dialog');
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

it('has no Cancel button', () => {
  mount();
  const labels = Array.from(
    requireElement('create-team-dialog').querySelectorAll('button'),
    (button) => button.textContent?.trim(),
  );
  expect(labels).not.toContain('Cancel');
});

it.each(DISMISSALS)('closes from the %s', (how) => {
  mount();
  dismiss(how);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(DISMISSALS)(
  'closes from the %s while a create is in flight',
  async (how) => {
    mount();
    act(() => typeName('Acme Engineering'));
    await act(async () => {
      requireElement('create-team-submit').click();
      await Promise.resolve();
    });
    const submit = requireElement('create-team-submit');
    expect(submit.textContent).toBe('Creating…');
    expect(submit).toHaveProperty('disabled', true);

    dismiss(how);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  },
);
