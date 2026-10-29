/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentObservabilitySnapshot } from '@canopy/desktop-shared/types';

jest.mock('@/components/pages/usage/MetricsTab', () => ({
  MetricsTab: ({ spec }: { spec: { id: string } }): JSX.Element => (
    <div data-testid={`metrics-tab-${spec.id}`} />
  ),
}));

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<{ auditRetentionDays: number }> =>
        Promise.resolve({ auditRetentionDays: 7 }),
      observability: {
        loadSnapshot: (): Promise<AgentObservabilitySnapshot> =>
          Promise.resolve({
            version: 1,
            historicalMode: 'forward-only',
            retentionDays: 7,
            recentEntries: [],
            usage: { updatedAt: '', providers: [] },
          }),
        loadHistory: (): Promise<{ entries: []; nextCursor?: string }> =>
          Promise.resolve({ entries: [] }),
        loadUsageMetricsView: (): Promise<{
          rows: [];
          resolvedWindow: { start: string; end: string };
          earliestEventAt: string;
        }> =>
          Promise.resolve({
            rows: [],
            resolvedWindow: {
              start: new Date(0).toISOString(),
              end: new Date(0).toISOString(),
            },
            earliestEventAt: new Date(0).toISOString(),
          }),
        onUpdate: (): (() => void) => () => {},
        refreshUsage: (): Promise<void> => Promise.resolve(),
      },
    },
  });
}

function render(node: ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

beforeEach(() => {
  installApi();
});

import { StatisticsPage } from '../StatisticsPage';

describe('StatisticsPage', () => {
  test('renders all seven tab buttons', async () => {
    const { container } = render(<StatisticsPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="statistics-tab-tokens"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="statistics-tab-cost"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="statistics-tab-worktrees"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="statistics-tab-chats"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="statistics-tab-chats"]')
        ?.textContent,
    ).toBe('Chats');
    expect(
      container.querySelector('[data-testid="statistics-tab-plans"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="statistics-tab-pipelines"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="statistics-tab-tools"]'),
    ).not.toBeNull();
  });

  test('switches to cost tab and renders MetricsTab', async () => {
    const { container } = render(<StatisticsPage />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="statistics-tab-cost"]')
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="metrics-tab-cost"]'),
    ).not.toBeNull();
  });

  test('switches to worktrees tab and renders MetricsTab', async () => {
    const { container } = render(<StatisticsPage />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="statistics-tab-worktrees"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="metrics-tab-worktrees"]'),
    ).not.toBeNull();
  });

  test('switches to pipelines tab and renders MetricsTab', async () => {
    const { container } = render(<StatisticsPage />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="statistics-tab-pipelines"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="metrics-tab-pipelines"]'),
    ).not.toBeNull();
  });
});
