/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NoticeShapeProvider } from '@canopy/ui-shared/components';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import { GitHubCloudReauthNotice } from '../GitHubCloudReauthNotice';
import {
  createFetchBackedGitHubPorts,
  GitHubTestHost,
  type TestBackendFetch,
  type TestLinkSocial,
} from './helpers/github-test-host';

// Every transport the notice could reach: the settings client, the backend
// the GitHub host's repository routes use, and the GitHub link.
const client = createFakeSettingsClient();
const fetchBackendUrl = jest.fn<
  ReturnType<TestBackendFetch>,
  Parameters<TestBackendFetch>
>();
const linkSocial = jest.fn<
  ReturnType<TestLinkSocial>,
  Parameters<TestLinkSocial>
>();
const github = createFetchBackedGitHubPorts(fetchBackendUrl, linkSocial);

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLElement;
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
  jest.clearAllMocks();
});

function render(
  props: Partial<Parameters<typeof GitHubCloudReauthNotice>[0]> = {},
  shape: 'default' | 'composer' = 'default',
): jest.Mock {
  const onReconnect = jest.fn();
  act(() => {
    root.render(
      <GitHubTestHost client={client} github={github}>
        <NoticeShapeProvider shape={shape}>
          <GitHubCloudReauthNotice onReconnect={onReconnect} {...props} />
        </NoticeShapeProvider>
      </GitHubTestHost>,
    );
  });
  return onReconnect;
}

function notice(): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-testid="github-cloud-reauth-notice"]',
  );
  if (!element) throw new Error('missing the reauth notice');
  return element;
}

function reconnect(): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-testid="github-cloud-reauth-reconnect"]',
  );
  if (!element) throw new Error('missing the Reconnect GitHub action');
  return element;
}

describe('GitHubCloudReauthNotice', () => {
  it('is the shared Notice: attention intent, a live status region, title first', () => {
    render();

    const element = notice();
    expect(element.getAttribute('data-notice-intent')).toBe('attention');
    expect(element.getAttribute('role')).toBe('status');
    expect(element.getAttribute('aria-live')).toBe('polite');
    expect(element.textContent).toContain('GitHub needs you to sign in again.');
    expect(element.textContent).toContain(
      'Reconnect GitHub to keep using your repositories in cloud projects.',
    );
  });

  it('tells the user a running worktree is not affected', () => {
    render();

    expect(notice().textContent).toContain(
      'Worktrees that are already running keep working.',
    );
  });

  it('offers one primary Reconnect GitHub action that calls onReconnect once per press', () => {
    const onReconnect = render();

    const button = reconnect();
    expect(button.textContent).toBe('Reconnect GitHub');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    // The shared NoticeButton primary tier.
    expect(button.className).toContain('bg-accent');
    expect(container.querySelectorAll('button')).toHaveLength(1);

    act(() => {
      button.click();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    act(() => {
      button.click();
    });
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('has no dismiss control: the state ends only when GitHub is reconnected', () => {
    render();

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it('shows Connecting… while busy, stays focusable and ignores presses', () => {
    const onReconnect = render({ busy: true });

    const button = reconnect();
    expect(button.textContent).toBe('Connecting…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);

    act(() => {
      button.click();
    });
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('keeps the same button, and its focus, across the busy transition', () => {
    const onReconnect = jest.fn();
    act(() => {
      root.render(<GitHubCloudReauthNotice onReconnect={onReconnect} />);
    });
    const button = reconnect();
    button.focus();

    act(() => {
      root.render(<GitHubCloudReauthNotice onReconnect={onReconnect} busy />);
    });

    expect(reconnect()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('takes the composer geometry from the surrounding NoticeShapeProvider', () => {
    render({}, 'composer');

    expect(notice().getAttribute('data-notice-shape')).toBe('composer');
  });

  it('is a pure view: pressing Reconnect touches no network, link or worktree API', () => {
    const onReconnect = render();

    act(() => {
      reconnect().click();
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(client.calls).toEqual([]);
    expect(fetchBackendUrl).not.toHaveBeenCalled();
    expect(linkSocial).not.toHaveBeenCalled();
  });

  it('names no product, so no brand is hard-coded', () => {
    render();

    expect(notice().textContent).not.toMatch(/canopy/i);
  });
});
