/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TeamApiError } from '../../organization/team-api';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { SETTINGS_LOAD_ERROR_COPY } from '../settings-error-copy';
import {
  useSettingsAccessLostRefresh,
  useSettingsLoadFailure,
} from '../use-settings-access-lost';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('settings access-lost hooks', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderHooks(): {
    loadCopy: (
      error: unknown,
      known?: Parameters<ReturnType<typeof useSettingsLoadFailure>>[1],
    ) => string;
    refreshOnAccessLost: ReturnType<typeof useSettingsAccessLostRefresh>;
    refresh: jest.Mock<void, []>;
  } {
    const refresh = jest.fn<void, []>();
    const { host } = createTestSettingsHost({ router: { refresh } });
    let loadCopy:
      | ((
          error: unknown,
          known?: Parameters<ReturnType<typeof useSettingsLoadFailure>>[1],
        ) => string)
      | null = null;
    let refreshOnAccessLost: ReturnType<
      typeof useSettingsAccessLostRefresh
    > | null = null;
    function Probe(): JSX.Element | null {
      const loadFailure = useSettingsLoadFailure('organization.test');
      loadCopy = (error, known): string => loadFailure(error, known).copy;
      refreshOnAccessLost = useSettingsAccessLostRefresh();
      return null;
    }
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <Probe />
        </TestSettingsHost>,
      );
    });
    if (loadCopy === null || refreshOnAccessLost === null)
      throw new Error('hooks did not render');
    return { loadCopy, refreshOnAccessLost, refresh };
  }

  it('refreshes once per mount when a load loses access', () => {
    const { loadCopy, refresh } = renderHooks();
    expect(loadCopy(new TeamApiError(403, 'SENTINEL'))).toBe(
      SETTINGS_LOAD_ERROR_COPY,
    );
    expect(loadCopy(new TeamApiError(401, 'SENTINEL'))).toBe(
      SETTINGS_LOAD_ERROR_COPY,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for other failures', () => {
    const { loadCopy, refreshOnAccessLost, refresh } = renderHooks();
    loadCopy(new TeamApiError(500, 'SENTINEL'));
    expect(refreshOnAccessLost(new TeamApiError(404))).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('lets a known 403 show its copy instead of refreshing', () => {
    const { loadCopy, refresh } = renderHooks();
    expect(
      loadCopy(new TeamApiError(403, 'SENTINEL', 'org_teams_lapsed'), [
        { status: 403, serverCode: 'org_teams_lapsed', copy: 'No plan.' },
      ]),
    ).toBe('No plan.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports access loss from the shared refresh callback', () => {
    const { refreshOnAccessLost, refresh } = renderHooks();
    expect(refreshOnAccessLost(new TeamApiError(403))).toBe(true);
    expect(refreshOnAccessLost(new TeamApiError(403))).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
