/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  expectSettingsCardHeading,
  expectSettingsCardShell,
  expectSettingsCardSubtitle,
} from '@canopy/ui-shared/components/settings/__tests__/helpers/settings-card-assertions';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { PersonalCatalogCard } from '../personal-catalog-card';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let mockEnabled = true;

function project(id: string): Record<string, unknown> {
  return {
    id,
    name: `Project ${id}`,
    kind: 'CODE',
    updatedAt: '2026-09-23T10:00:00.000Z',
    online: true,
  };
}

type ListAnswer = () => Promise<unknown>;
type DeleteAnswer = () => Promise<unknown>;

let listAnswer: ListAnswer;
let deleteAnswer: DeleteAnswer;
let client: FakeSettingsClient;

function callsFor(method: 'GET' | 'DELETE'): number {
  const operation =
    method === 'DELETE'
      ? 'account.profile.projects.remove'
      : 'account.profile.projects.read';
  return client.calls.filter((call) => call.operation === operation).length;
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderCard(): Promise<void> {
  const { host } = createTestSettingsHost({ client });
  const workspaceContext = host.useWorkspaceContext();
  await act(async (): Promise<void> => {
    root.render(
      <TestSettingsHost
        host={{
          ...host,
          useWorkspaceContext: () => ({
            ...workspaceContext,
            enabled: mockEnabled,
          }),
        }}
      >
        <PersonalCatalogCard />
      </TestSettingsHost>,
    );
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async (): Promise<void> => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function removeButton(): Element | null {
  return container.querySelector('[data-testid="personal-catalog-remove"]');
}

function dialog(): Element | null {
  return document.body.querySelector(
    '[data-testid="personal-catalog-remove-confirm"]',
  );
}

function confirmButton(): HTMLButtonElement | null {
  return (
    dialog()?.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-dialog-confirm"]',
    ) ?? null
  );
}

function cancelButton(): HTMLButtonElement | null {
  return (
    dialog()?.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-dialog-cancel"]',
    ) ?? null
  );
}

beforeEach((): void => {
  mockEnabled = true;
  listAnswer = async (): Promise<unknown> => ({
    projects: [project('a'), project('b')],
  });
  deleteAnswer = async (): Promise<unknown> => ({ catalogGeneration: 2 });
  client = createFakeSettingsClient({
    'account.profile.projects.read': () => listAnswer(),
    'account.profile.projects.remove': () => deleteAnswer(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => root.unmount());
  container.remove();
});

it('renders nothing when the synced list is empty', async (): Promise<void> => {
  listAnswer = async (): Promise<unknown> => ({ projects: [] });
  await renderCard();

  expect(callsFor('GET')).toBe(1);
  expect(container.innerHTML).toBe('');
});

it('opens a confirmation instead of removing on the first click', async (): Promise<void> => {
  await renderCard();
  await click(removeButton());

  expect(dialog()).not.toBeNull();
  expect(dialog()?.textContent).toContain(
    'To show them again, turn sharing off and back on in the Canopy desktop app.',
  );
  expect(dialog()?.textContent).not.toContain('Privacy settings');
  expect(callsFor('DELETE')).toBe(0);
});

it('renders nothing and does not fetch when organization projects are off', async (): Promise<void> => {
  mockEnabled = false;
  await renderCard();

  expect(client.calls).toEqual([]);
  expect(container.innerHTML).toBe('');
});

it.each([
  [
    'a 404',
    async (): Promise<unknown> => {
      throw new SettingsOperationError({
        code: 'not_found',
        status: 404,
        message: 'Not found',
      });
    },
  ],
  [
    'a network failure',
    async (): Promise<unknown> => {
      throw new SettingsOperationError({ code: 'offline' });
    },
  ],
  [
    'an invalid body',
    async (): Promise<unknown> => ({ projects: [{ id: 1 }] }),
  ],
])(
  'renders nothing on %s',
  async (_label: string, answer: ListAnswer): Promise<void> => {
    listAnswer = answer;
    await renderCard();

    expect(callsFor('GET')).toBe(1);
    expect(container.innerHTML).toBe('');
  },
);

it('renders a calm settings card with the synced count', async (): Promise<void> => {
  await renderCard();

  expectSettingsCardShell(container, 'personal-catalog-card');
  expectSettingsCardHeading(container, 'Projects shown on the web');
  expectSettingsCardSubtitle(container, 'personal-catalog-card');
  expect(container.textContent).toContain('Canopy');
  expect(
    container.querySelector('[data-testid="personal-catalog-count"]')
      ?.textContent,
  ).toBe('2 projects');
  const button = removeButton();
  expect(button?.textContent).toBe('Remove from web');
  expect(button?.classList.contains('bg-destructive')).toBe(false);
  expect(button?.classList.contains('w-full')).toBe(false);
});

it('uses the singular for one project', async (): Promise<void> => {
  listAnswer = async (): Promise<unknown> => ({ projects: [project('a')] });
  await renderCard();

  expect(
    container.querySelector('[data-testid="personal-catalog-count"]')
      ?.textContent,
  ).toBe('1 project');
});

it('removes the list once confirmed and shows the success notice', async (): Promise<void> => {
  await renderCard();
  await click(removeButton());
  await click(confirmButton());

  expect(callsFor('DELETE')).toBe(1);
  expect(client.calls.at(-1)).toEqual({
    operation: 'account.profile.projects.remove',
    input: {},
  });
  expect(dialog()).toBeNull();
  expect(removeButton()).toBeNull();
  expect(
    container.querySelector('[data-testid="personal-catalog-count"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="personal-catalog-removed"]')
      ?.textContent,
  ).toBe(
    'Your projects were removed from the web. Turn sharing off and back on in the Canopy desktop app to show them again.',
  );
  expect(callsFor('GET')).toBe(1);
});

it('disables the confirm button while the removal runs', async (): Promise<void> => {
  deleteAnswer = (): Promise<unknown> => new Promise((): void => {});
  await renderCard();
  await click(removeButton());
  await click(confirmButton());

  expect(confirmButton()?.disabled).toBe(true);
  expect(confirmButton()?.textContent).toBe('Removing…');
});

it.each([
  [
    'a failed response',
    async (): Promise<unknown> => {
      throw new SettingsOperationError({
        code: 'uncertain',
        status: 500,
        message: 'boom',
      });
    },
  ],
  [
    'a rejected request',
    async (): Promise<unknown> => {
      throw new SettingsOperationError({ code: 'offline' });
    },
  ],
])(
  'keeps the dialog open with the error after %s',
  async (_label: string, answer: DeleteAnswer): Promise<void> => {
    deleteAnswer = answer;
    await renderCard();
    await click(removeButton());
    await click(confirmButton());

    expect(dialog()).not.toBeNull();
    const alert = dialog()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "Couldn't remove your projects. Try again.",
    );
    expect(confirmButton()?.disabled).toBe(false);

    await click(confirmButton());
    expect(callsFor('DELETE')).toBe(2);
  },
);

it('cancels without removing and reopens without a stale error', async (): Promise<void> => {
  deleteAnswer = async (): Promise<unknown> => {
    throw new SettingsOperationError({ code: 'uncertain', status: 500 });
  };
  await renderCard();
  await click(removeButton());
  await click(cancelButton());

  expect(dialog()).toBeNull();
  expect(callsFor('DELETE')).toBe(0);

  await click(removeButton());
  await click(confirmButton());
  expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
  await click(cancelButton());
  await click(removeButton());

  expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
  expect(callsFor('DELETE')).toBe(1);
});
