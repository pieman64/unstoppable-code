/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
} from '@canopy/desktop-shared/types';
import { querySettingsSelect } from '@canopy/ui-app/settings/__tests__/helpers/settings-select';
import { MetricsBreakdownPanel } from '../MetricsBreakdownPanel';
import { CHATS_TAB_SPEC } from '../tab-specs';

jest.mock('@/components/shared/StatusBlocks', () => ({
  LoadingPlaceholder: (): JSX.Element => <div data-testid="placeholder" />,
}));

const loadMetricsView = jest.fn<
  Promise<UsageMetricsViewResponse>,
  [UsageMetricsViewRequest]
>();

jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ loadUsageMetricsView: loadMetricsView }),
}));

function response(
  rows: UsageMetricsViewResponse['rows'],
): UsageMetricsViewResponse {
  return {
    rows,
    resolvedWindow: { start: '', end: '' },
    earliestEventAt: '',
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('MetricsBreakdownPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadMetricsView.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('groups by workspace by default', async () => {
    loadMetricsView.mockResolvedValue(
      response([{ key: 'ws-1', label: 'Secret Project', count: 3 }]),
    );
    act(() => root.render(<MetricsBreakdownPanel spec={CHATS_TAB_SPEC} />));
    await flush();

    const groupBy = querySettingsSelect(
      container,
      '[data-testid="usage-breakdown-groupby-chats"]',
    );
    expect(groupBy?.value).toBe('workspace');
  });

  it('reloads the breakdown grouped by provider', async () => {
    loadMetricsView.mockResolvedValue(
      response([{ key: 'codex', label: 'codex', count: 2 }]),
    );
    act(() => root.render(<MetricsBreakdownPanel spec={CHATS_TAB_SPEC} />));
    await flush();

    const groupBy = querySettingsSelect(
      container,
      '[data-testid="usage-breakdown-groupby-chats"]',
    );
    groupBy?.choose('provider');
    await flush();

    expect(loadMetricsView).toHaveBeenLastCalledWith(
      expect.objectContaining({ groupBy: 'provider' }),
    );
  });
});
