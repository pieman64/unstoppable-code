/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { JSX } from 'react';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { TestSettingsHost } from '../../../__tests__/helpers/test-settings-host';
import {
  chooseSettingsOption,
  settingsSelectOptionLabels,
  settingsSelectTrigger,
} from '../../../__tests__/helpers/settings-select';
import { TeamStatisticsSection } from '../TeamStatisticsSection';
import {
  createStatisticsTestHost,
  usageCalls,
  type StatisticsTestHost,
} from './helpers/statistics-host';

// The usage read stays pending (the helper's default) so the component stays
// on its loading state and the controls (the surface under test) render
// without async state churn. View state lives in the URL: the host's
// `router.replace` writes the search params `useSearchParams` reads back, and
// tests re-render after an interaction to reflect the new URL.
let statsHost: StatisticsTestHost;
const mockReplace = (): StatisticsTestHost['replace'] => statsHost.replace;

function setMockParams(queryString: string): void {
  statsHost.setParams(queryString);
}

function withHost(element: JSX.Element): JSX.Element {
  return <TestSettingsHost host={statsHost.host}>{element}</TestSettingsHost>;
}

beforeEach(() => {
  statsHost = createStatisticsTestHost();
});

// The filter selects now live inside a popover collapsed behind an icon
// trigger. Open it before querying the selects. The popover's open state
// survives the `reflectUrl()` re-renders (same component position), so a
// single call keeps the selects mounted across subsequent interactions.
function openFilters(container: HTMLElement): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-testid="usage-filters-trigger"]',
  );
  if (!trigger) {
    throw new Error('filters trigger not found');
  }
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TeamStatisticsSection range control', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    setMockParams('');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(): void {
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />,
        ),
      );
    });
  }

  // Re-render after an interaction so the tree reflects the URL that `replace`
  // just wrote (a fresh element forces reconciliation).
  function reflectUrl(): void {
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />,
        ),
      );
    });
  }

  function rangeSelect(): HTMLButtonElement {
    return settingsSelectTrigger(
      container,
      '[data-testid="usage-range-select"]',
    );
  }

  function granularitySelect(): HTMLButtonElement {
    return settingsSelectTrigger(
      container,
      '[data-testid="usage-granularity-select"]',
    );
  }

  it('renders all five range options including the short ranges', () => {
    render();
    // Range is now a standalone header control, queryable without opening the
    // popover.
    const labels = settingsSelectOptionLabels(rangeSelect());
    expect(labels).toEqual([
      'Last 1 hour',
      'Last 1 day',
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
    ]);
  });

  it('defaults to the Last 7 days range with daily granularity', () => {
    render();
    openFilters(container);
    expect(rangeSelect().dataset.value).toBe(String(7 * 24 * 60 * 60 * 1000));
    expect(granularitySelect().dataset.value).toBe('day');
  });

  async function changeRange(ms: string): Promise<void> {
    await chooseSettingsOption(rangeSelect(), ms);
    reflectUrl();
  }

  it('forces hourly granularity when a short range is selected', async () => {
    render();
    openFilters(container);
    const oneHourMs = String(60 * 60 * 1000);
    await changeRange(oneHourMs);
    expect(rangeSelect().dataset.value).toBe(oneHourMs);
    expect(granularitySelect().dataset.value).toBe('hour');
  });

  it('lights the active-filter dot when a short range forces hourly granularity', async () => {
    // Range itself is excluded from the popover active-filter dot, but selecting
    // a sub-day range forces granularity to `hour` (a non-default popover
    // filter), which lights the dot indirectly. This guards the coupling
    // documented on `hasActiveFilters` — a URL that only carries `range=1h`
    // would not, since granularity is derived from the `gran` param, so the
    // interactive select change is what exercises the real path.
    render();
    expect(
      container.querySelector('[data-testid="usage-filters-active-dot"]'),
    ).toBeNull();
    await changeRange(String(60 * 60 * 1000));
    expect(
      container.querySelector('[data-testid="usage-filters-active-dot"]'),
    ).not.toBeNull();
  });

  it('leaves granularity untouched for multi-day ranges', async () => {
    render();
    openFilters(container);
    const ninetyDaysMs = String(90 * 24 * 60 * 60 * 1000);
    await changeRange(ninetyDaysMs);
    expect(rangeSelect().dataset.value).toBe(ninetyDaysMs);
    expect(granularitySelect().dataset.value).toBe('day');
  });

  it('keeps the Filters panel open while a choice is pressed in its dropdown menu', () => {
    render();
    openFilters(container);
    const trigger = granularitySelect();
    act(() => trigger.click());
    const listId = trigger.getAttribute('aria-controls');
    const option = (
      listId ? document.getElementById(listId) : null
    )?.querySelector<HTMLElement>('[role="option"][data-value="week"]');
    if (!option) throw new Error('granularity menu did not open');
    // The menu renders outside the panel; a real press sends mousedown first.
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      option.click();
    });
    reflectUrl();
    expect(
      container.querySelector('[data-testid="usage-granularity-select"]'),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(granularitySelect().dataset.value).toBe('week');
  });

  it('restores daily granularity when returning from a short range to a multi-day range', async () => {
    render();
    openFilters(container);
    const oneHourMs = String(60 * 60 * 1000);
    const ninetyDaysMs = String(90 * 24 * 60 * 60 * 1000);

    // Selecting a short range forces hourly granularity.
    await changeRange(oneHourMs);
    expect(granularitySelect().dataset.value).toBe('hour');

    // Switching back to a multi-day range must step granularity back up to
    // daily rather than leaving it stuck on hourly (which would issue a
    // ~2,160-bucket query over 90 days).
    await changeRange(ninetyDaysMs);
    expect(rangeSelect().dataset.value).toBe(ninetyDaysMs);
    expect(granularitySelect().dataset.value).toBe('day');
  });
});

describe('TeamStatisticsSection URL-driven view state', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    setMockParams('');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(initialQuery = ''): void {
    setMockParams(initialQuery);
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />,
        ),
      );
    });
  }

  function tab(key: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      `[data-testid="usage-metric-tab-${key}"]`,
    );
    if (!el) {
      throw new Error(`tab ${key} not found`);
    }
    return el;
  }

  it('marks the tab from ?tab= active on first render', () => {
    render('tab=people');
    expect(tab('people').getAttribute('aria-pressed')).toBe('true');
    expect(tab('overview').getAttribute('aria-pressed')).toBe('false');
  });

  it('replaces the URL with ?tab=people when the People tab is clicked', async () => {
    render();
    await act(async () => {
      tab('people').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mockReplace()).toHaveBeenCalledWith(
      '/organization/org-1/statistics?tab=people',
      { scroll: false },
    );
  });

  it('collapses back to a clean URL when returning to the default tab', async () => {
    render('tab=people');
    await act(async () => {
      tab('overview').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mockReplace()).toHaveBeenCalledWith(
      '/organization/org-1/statistics',
      {
        scroll: false,
      },
    );
  });

  it('writes the range short key (not raw ms) into the URL', async () => {
    render();
    // Range renders in the header now, so no popover open is needed.
    await chooseSettingsOption(
      settingsSelectTrigger(container, '[data-testid="usage-range-select"]'),
      String(30 * 24 * 60 * 60 * 1000),
    );
    expect(mockReplace()).toHaveBeenCalledWith(
      '/organization/org-1/statistics?range=30d',
      { scroll: false },
    );
  });

  it('shows no active-filter dot with default filters', () => {
    render();
    expect(
      container.querySelector('[data-testid="usage-filters-active-dot"]'),
    ).toBeNull();
  });

  it('does not light the active-filter dot for a range-only change', () => {
    // Range is a visible standalone control now, so it is excluded from the
    // popover active-filter dot.
    render('range=30d');
    expect(
      container.querySelector('[data-testid="usage-filters-active-dot"]'),
    ).toBeNull();
  });

  it('lights the active-filter dot for a non-default popover filter', () => {
    // A coarser granularity is still hidden in the popover, so it drives the dot.
    render('gran=week');
    expect(
      container.querySelector('[data-testid="usage-filters-active-dot"]'),
    ).not.toBeNull();
  });

  it('renders no Observed cost tab and lands ?tab=cost on Overview', () => {
    render('tab=cost');
    // The dedicated Observed cost tab was folded into Overview and removed.
    expect(
      container.querySelector('[data-testid="usage-metric-tab-cost"]'),
    ).toBeNull();
    // A stale ?tab=cost deep link falls back to the default Overview tab.
    expect(tab('overview').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('TeamStatisticsSection personal organization (CAN-3597)', () => {
  let container: HTMLElement;
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

  function render(personal: boolean): void {
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[{ id: 'team-1', name: 'Growth', memberCount: 1 }]}
            members={[
              {
                id: 'user-1',
                name: 'Owner',
                email: 'owner@example.com',
                image: null,
                role: 'OWNER',
                subTeamIds: [],
              },
            ]}
            personal={personal}
          />,
        ),
      );
    });
  }

  it('offers granularity only and no People leaderboard', () => {
    setMockParams('');
    render(true);
    openFilters(container);
    expect(
      container.querySelector('[data-testid="usage-granularity-select"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="usage-scope-select"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="usage-user-select"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('People');
  });

  it('ignores stale team, person, and People params instead of sending them', () => {
    setMockParams('scope=team&team=team-1&user=user-1&tab=people');
    render(true);
    const calls = usageCalls(statsHost.client);
    expect(calls).toHaveLength(1);
    const [query] = calls;
    expect(query).toMatchObject({ scope: 'organization' });
    expect(query).not.toHaveProperty('teamId');
    expect(query).not.toHaveProperty('userId');
    expect(
      container.querySelector('[data-testid="usage-select-team"]'),
    ).toBeNull();
  });

  it('keeps the team and person filters for an ordinary organization', () => {
    setMockParams('');
    render(false);
    openFilters(container);
    expect(
      container.querySelector('[data-testid="usage-scope-select"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="usage-user-select"]'),
    ).not.toBeNull();
  });
});

describe('TeamStatisticsSection load errors', () => {
  let container: HTMLElement;
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

  async function renderWith(usage: (input: unknown) => unknown): Promise<void> {
    statsHost = createStatisticsTestHost({ usage });
    await act(async () => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />,
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('shows load copy, never the route text, and Retry fetches again', async () => {
    let calls = 0;
    await renderWith(() => {
      calls += 1;
      if (calls === 1)
        throw new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: 'SENTINEL-SERVER-BODY',
        });
      return new Promise<never>(() => {});
    });

    expect(container.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
    expect(container.querySelector('[data-testid="usage-empty"]')).toBeNull();

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(usageCalls(statsHost.client)).toHaveLength(2);
    expect(container.textContent).not.toContain("Couldn't load this.");
    expect(
      container.querySelector('[data-testid="usage-loading"]'),
    ).not.toBeNull();
  });

  it('names the missing plan for a plan-gated organization', async () => {
    await renderWith(() => {
      throw new SettingsOperationError({
        code: 'forbidden',
        status: 403,
        serverCode: 'org_teams_lapsed',
        message: 'SENTINEL-SERVER-BODY',
      });
    });

    expect(container.textContent).toContain(
      'This organization has no active plan. An owner can choose one in Billing.',
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });
});
