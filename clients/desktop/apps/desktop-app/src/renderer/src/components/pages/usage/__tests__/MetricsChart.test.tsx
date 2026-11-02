/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MetricsChart } from '../MetricsChart';
import { PIPELINES_TAB_SPEC } from '../tab-specs';

jest.mock('@/components/shared/StatusBlocks', () => ({
  LoadingPlaceholder: (): JSX.Element => <div data-testid="placeholder" />,
}));

jest.mock('../MetricsCountsChart', () => ({
  MetricsCountsChart: (): JSX.Element => <div data-testid="counts-chart" />,
  colorForSeries: (): string => '#000',
}));

jest.mock('../MetricsDistributionChart', () => ({
  MetricsDistributionChart: (): JSX.Element => (
    <div data-testid="distribution-chart" />
  ),
}));

const pending = (): Promise<never> => new Promise<never>(() => {});

jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      loadUsageMetricsView: pending,
      loadUsageTimeseries: pending,
    }),
}));

describe('MetricsChart', () => {
  test('shows the workflow chart heading, not the stored panel title (CAN-4651)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<MetricsChart spec={PIPELINES_TAB_SPEC} retentionDays={7} />);
    });

    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe('Workflow runs');
    expect(container.textContent).not.toMatch(/pipeline/i);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
