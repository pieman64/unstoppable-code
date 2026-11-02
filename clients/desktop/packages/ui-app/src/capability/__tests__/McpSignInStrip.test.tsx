/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { McpServersSectionItem } from '../../code/activity/McpServersSectionBody';
import {
  McpSignInStrip,
  mcpServersNeedingSignIn,
  mcpSignInSummary,
} from '../McpSignInStrip';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function server(
  key: string,
  displayName: string,
  authStatus: McpServersSectionItem['authStatus'],
): McpServersSectionItem {
  return {
    key,
    source: 'account',
    displayName,
    enabled: true,
    configName: 'Default',
    authStatus,
    authStatusLabel: 'Card label',
    canConnect: authStatus !== 'connected',
    canDisconnect: true,
  };
}

const LINEAR = server('linear/default', 'Linear', 'not_connected');
const SLACK = server('slack/default', 'Slack', 'expired');

describe('mcpSignInSummary', () => {
  it('names each server that still needs sign-in', () => {
    expect(mcpSignInSummary(['Linear'])).toBe('Sign in to use Linear');
    expect(mcpSignInSummary(['Linear', 'Slack'])).toBe(
      'Sign in to use Linear and Slack',
    );
    expect(mcpSignInSummary(['Linear', 'Slack', 'Notion'])).toBe(
      'Sign in to use Linear, Slack, and Notion',
    );
    expect(mcpSignInSummary(['Linear', 'Slack', 'Notion', 'Figma'])).toBe(
      'Sign in to use Linear, Slack, and 2 more',
    );
  });
});

describe('mcpServersNeedingSignIn', () => {
  it('keeps servers that need Connect or Reconnect', () => {
    const renewing: McpServersSectionItem = {
      ...server('docs/default', 'Docs', 'expired'),
      canRefresh: true,
    };
    expect(
      mcpServersNeedingSignIn([
        LINEAR,
        SLACK,
        renewing,
        server('github/default', 'GitHub', 'connected'),
      ]).map((item) => item.key),
    ).toEqual(['linear/default', 'slack/default']);
  });
});

describe('McpSignInStrip', () => {
  let container: HTMLDivElement;
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

  function render(
    servers: readonly McpServersSectionItem[],
    onConnect: (item: McpServersSectionItem) => void = jest.fn(),
    summary?: (pending: readonly McpServersSectionItem[]) => string,
  ): void {
    act(() =>
      root.render(
        <McpSignInStrip
          servers={servers}
          onConnect={onConnect}
          {...(summary === undefined ? {} : { summary })}
        />,
      ),
    );
  }

  function strip(): HTMLElement | null {
    return container.querySelector('[data-testid="mcp-sign-in-strip"]');
  }

  function rows(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="mcp-servers-card-row"]',
      ),
    );
  }

  function rowText(row: HTMLElement, testId: string): string | undefined {
    return (
      row.querySelector(`[data-testid="${testId}"]`)?.textContent ?? undefined
    );
  }

  it('lists the selected servers that need sign-in with Sign in or Reconnect', () => {
    render([LINEAR, SLACK]);
    expect(
      container.querySelector('[data-testid="mcp-sign-in-strip-summary"]')
        ?.textContent,
    ).toBe('Sign in to use Linear and Slack');
    const [linear, slack] = rows();
    expect(rowText(linear, 'mcp-servers-card-name')).toBe('Linear');
    expect(rowText(linear, 'mcp-servers-card-badge')).toBe('Sign-in needed');
    expect(rowText(linear, 'mcp-servers-card-connect')).toBe('Sign in');
    expect(rowText(slack, 'mcp-servers-card-badge')).toBe('Sign-in expired');
    expect(rowText(slack, 'mcp-servers-card-connect')).toBe('Sign in');
    expect(
      container.querySelector('[data-testid="mcp-servers-card-disconnect"]'),
    ).toBeNull();
  });

  it('takes a host summary, and keeps a relabelled row its own badge and action', () => {
    const OPEN = {
      ...server('open/default', 'Open data', 'not_connected'),
      authStatusLabel: 'Not enabled',
      connectActionLabel: 'Enable',
    };
    const summary = jest.fn(
      (pending: readonly McpServersSectionItem[]): string =>
        `${String(pending.length)} pending`,
    );
    render([LINEAR, OPEN], jest.fn(), summary);
    expect(
      container.querySelector('[data-testid="mcp-sign-in-strip-summary"]')
        ?.textContent,
    ).toBe('2 pending');
    const [linear, open] = rows();
    expect(rowText(linear, 'mcp-servers-card-badge')).toBe('Sign-in needed');
    expect(rowText(open, 'mcp-servers-card-badge')).toBe('Not enabled');
    expect(rowText(open, 'mcp-servers-card-connect')).toBe('Enable');
  });

  it('wires Connect to the row it belongs to', () => {
    const onConnect = jest.fn<void, [McpServersSectionItem]>();
    render([LINEAR, SLACK], onConnect);
    const button = rows()[1].querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-connect"]',
    );
    act(() => button?.click());
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0]).toMatchObject({ key: 'slack/default' });
  });

  it('renders nothing when every selected server is signed in', () => {
    render([server('linear/default', 'Linear', 'connected')]);
    expect(strip()).toBeNull();
  });

  it('turns a row Signed in and hides once every server is connected', () => {
    render([LINEAR, SLACK]);
    render([server('linear/default', 'Linear', 'connected'), SLACK]);
    expect(
      container.querySelector('[data-testid="mcp-sign-in-strip-summary"]')
        ?.textContent,
    ).toBe('Sign in to use Slack');
    const [linear] = rows();
    expect(rowText(linear, 'mcp-servers-card-badge')).toBe('Connected');
    expect(
      linear.querySelector('[data-testid="mcp-servers-card-connect"]'),
    ).toBeNull();
    render([
      server('linear/default', 'Linear', 'connected'),
      server('slack/default', 'Slack', 'connected'),
    ]);
    expect(strip()).toBeNull();
  });

  it('follows the selection as servers are added and removed', () => {
    render([LINEAR]);
    expect(rows()).toHaveLength(1);
    render([LINEAR, SLACK]);
    expect(rows().map((row) => rowText(row, 'mcp-servers-card-name'))).toEqual([
      'Linear',
      'Slack',
    ]);
    render([SLACK]);
    expect(rows().map((row) => rowText(row, 'mcp-servers-card-name'))).toEqual([
      'Slack',
    ]);
    render([]);
    expect(strip()).toBeNull();
  });

  it('does not list a server that was already signed in when it was added', () => {
    render([LINEAR, server('docs/default', 'Docs', 'connected')]);
    expect(rows().map((row) => rowText(row, 'mcp-servers-card-name'))).toEqual([
      'Linear',
    ]);
  });
});
