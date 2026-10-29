/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsLogger } from '../../host/settings-host';
import { TeamApiError } from '../../organization/team-api';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import {
  useSettingsErrorCopy,
  type SettingsErrorCopy,
} from '../use-settings-error-copy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useSettingsErrorCopy', () => {
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

  function renderHook(): {
    copy: SettingsErrorCopy;
    warn: jest.Mock<void, [string, Record<string, unknown>?]>;
    scopes: string[];
  } {
    const warn = jest.fn<void, [string, Record<string, unknown>?]>();
    const scopes: string[] = [];
    const logger: SettingsLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
    };
    const { host } = createTestSettingsHost();
    const loggingHost = {
      ...host,
      logger: (scope: string): SettingsLogger => {
        scopes.push(scope);
        return logger;
      },
    };
    let captured: SettingsErrorCopy | null = null;
    function Probe(): JSX.Element | null {
      captured = useSettingsErrorCopy('organization.settings');
      return null;
    }
    act(() => {
      root.render(
        <TestSettingsHost host={loggingHost}>
          <Probe />
        </TestSettingsHost>,
      );
    });
    if (captured === null) throw new Error('hook did not render');
    return { copy: captured, warn, scopes };
  }

  it('returns action copy and logs the truncated server text under its scope', () => {
    const { copy, warn, scopes } = renderHook();
    const body = `SENTINEL ${'y'.repeat(300)}`;
    const text = copy.actionCopy(new TeamApiError(500, body), {
      action: 'rename this organization',
    });
    expect(text).toBe("Couldn't rename this organization. Try again.");
    expect(scopes).toEqual(['organization.settings']);
    const [message, meta] = warn.mock.calls[0];
    expect(message).toBe(
      `rename this organization failed (status=500): ${body.slice(0, 200)}…`,
    );
    expect(meta).toMatchObject({ status: 500, detail: body });
  });

  it('returns load copy and logs the failure', () => {
    const { copy, warn } = renderHook();
    expect(
      copy.loadCopy(new TeamApiError(403), [
        { status: 403, copy: 'Plan gate.' },
      ]),
    ).toBe('Plan gate.');
    expect(warn.mock.calls[0][0]).toBe('load failed (status=403)');
  });
});
