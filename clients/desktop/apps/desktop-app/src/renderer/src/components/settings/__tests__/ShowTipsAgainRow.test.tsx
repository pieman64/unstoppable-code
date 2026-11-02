/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/require-await -- act(async) flushes resolved fakes. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import {
  createPlanModeHintStore,
  CanopyClientProvider,
} from '@canopy/app-state';
import type {
  OnboardingTipDismissals,
  OnboardingTipsUpdate,
} from '@canopy/protocol/onboarding-tips';
import { ShowTipsAgainRow } from '../ShowTipsAgainRow';

const mockHintStore = createPlanModeHintStore({
  load: async () => ({
    record: { version: 1, generation: 0 },
    persisted: true,
  }),
  save: async (record) => record,
});
jest.mock('@/lib/planModeHint', () => ({
  getPlanModeHintStore: (): typeof mockHintStore => mockHintStore,
  resetPlanModeHint: async (): Promise<void> => {
    await mockHintStore.getState().reset();
  },
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function fakeClient(
  dismissed: OnboardingTipDismissals,
  options: { readonly failReset?: boolean } = {},
): { client: CanopyClient; updates: OnboardingTipsUpdate[] } {
  const updates: OnboardingTipsUpdate[] = [];
  const client = {
    capabilities: { onboardingTips: true },
    query: jest.fn(() => Promise.resolve({ dismissed })),
    command: jest.fn((_name: string, args: OnboardingTipsUpdate) => {
      updates.push(args);
      return options.failReset
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ dismissed: {} });
    }),
    subscribe: jest.fn((): (() => void) => () => undefined),
  };
  // Only the onboarding tip operations and capabilities are reached.
  return { client: client as unknown as CanopyClient, updates };
}

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  await mockHintStore.getState().hydrate();
  await mockHintStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(client: CanopyClient): Promise<void> {
  await act(async () => {
    root.render(
      <CanopyClientProvider client={client}>
        <ShowTipsAgainRow />
      </CanopyClientProvider>,
    );
  });
  await act(async () => undefined);
}

const button = (): HTMLButtonElement | null =>
  container.querySelector('[data-testid="settings-canopy-show-tips-again"]');

describe('ShowTipsAgainRow', () => {
  it('stays hidden until a tip has been dismissed', async () => {
    await render(fakeClient({}).client);
    expect(button()).toBeNull();
  });

  it('brings every tip back and then hides', async () => {
    const { client, updates } = fakeClient({
      workflows: '2026-10-24T09:00:00.000Z',
    });
    await render(client);
    expect(button()?.textContent).toBe('Show tips again');
    await act(async () => button()?.click());
    await act(async () => undefined);
    expect(updates).toEqual([{ action: 'reset' }]);
    expect(button()).toBeNull();
  });

  it('brings back a retired plan hint even when no contextual tip was dismissed', async () => {
    await mockHintStore.getState().markDismissed();
    const generation = mockHintStore.getState().record?.generation;
    await render(fakeClient({}).client);
    expect(button()).not.toBeNull();
    await act(async () => button()?.click());
    expect(mockHintStore.getState().record).toEqual({
      version: 1,
      generation: (generation ?? 0) + 1,
    });
    expect(button()).toBeNull();
  });

  it('says so when the tips could not be brought back', async () => {
    const { client } = fakeClient(
      { workflows: '2026-10-24T09:00:00.000Z' },
      { failReset: true },
    );
    await render(client);
    await act(async () => button()?.click());
    await act(async () => undefined);
    expect(container.textContent).toContain(
      "Couldn't bring the tips back. Try again.",
    );
    expect(button()).toBeInstanceOf(HTMLButtonElement);
  });
});
