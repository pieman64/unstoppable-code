/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TelemetrySyncStatus } from '@canopy/desktop-shared/types';
import { CloudSyncStatus } from '../CloudSyncStatus';

const BASE: TelemetrySyncStatus = {
  isSyncing: false,
  pendingCount: 0,
  sharingActive: true,
  lastSyncedAt: null,
  lastErrorAt: null,
  lastError: null,
};

describe('CloudSyncStatus', () => {
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

  function render(
    status: TelemetrySyncStatus | null,
    cloudConnected: boolean | null = true,
  ): void {
    act(() => {
      root.render(
        <CloudSyncStatus status={status} cloudConnected={cloudConnected} />,
      );
    });
  }

  function statusEl(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="settings-cloud-sync-status"]',
    );
  }

  it('renders nothing when status is null', () => {
    render(null);
    expect(statusEl()).toBeNull();
  });

  describe('sync paused (CAN-3512)', () => {
    const OLD = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

    function pausedEl(): HTMLElement | null {
      return container.querySelector<HTMLElement>(
        '[data-testid="settings-cloud-sync-status-paused"]',
      );
    }

    it('shows Sync paused for a stalled queue instead of an old Synced time', () => {
      render({
        ...BASE,
        pendingCount: 12,
        lastSyncedAt: OLD,
        pausedReason: 'queue-stalled',
      });
      expect(statusEl()?.textContent).toBe('Sync paused · 12 pending');
      expect(pausedEl()).not.toBeNull();
    });

    it('keeps Sign in to sync first when the credential is the cause', () => {
      render(
        { ...BASE, pendingCount: 2, pausedReason: 'queue-stalled' },
        false,
      );
      expect(statusEl()?.textContent).toBe('Sign in to sync · 2 pending');
      expect(pausedEl()).toBeNull();
    });

    it('keeps a recorded upload failure first', () => {
      render({
        ...BASE,
        lastError: 'upload-failed',
        lastErrorAt: OLD,
        pausedReason: 'queue-stalled',
      });
      expect(statusEl()?.textContent).toContain('Sync failed');
      expect(pausedEl()).toBeNull();
    });
  });

  it('shows privacy as enabled when every scope is off', () => {
    render({ ...BASE, sharingActive: false });
    expect(statusEl()?.textContent).toBe('Privacy enabled');
  });

  it('shows a syncing indicator with pending count', () => {
    render({ ...BASE, isSyncing: true, pendingCount: 3 });
    expect(statusEl()?.textContent).toContain('Syncing…');
    expect(statusEl()?.textContent).toContain('3 pending');
  });

  it('shows a failed state with relative time', () => {
    render({
      ...BASE,
      lastError: 'upload-failed',
      lastErrorAt: new Date(Date.now() - 60_000).toISOString(),
      pendingCount: 2,
    });
    const text = statusEl()?.textContent ?? '';
    expect(text).toContain('Sync failed');
    expect(text).toContain('1m ago');
    expect(text).toContain('2 pending');
  });

  it('shows the last synced relative time', () => {
    render({
      ...BASE,
      lastSyncedAt: new Date(Date.now() - 300_000).toISOString(),
    });
    expect(statusEl()?.textContent).toContain('Synced 5m ago');
  });

  it('appends pending count to the synced label', () => {
    render({
      ...BASE,
      lastSyncedAt: new Date(Date.now() - 300_000).toISOString(),
      pendingCount: 4,
    });
    expect(statusEl()?.textContent).toContain('4 pending');
  });

  it('shows a waiting note when sharing is on but never synced', () => {
    render({ ...BASE });
    expect(statusEl()?.textContent).toBe('Waiting to sync…');
  });

  it('shows a pending count when waiting with queued items', () => {
    render({ ...BASE, pendingCount: 7 });
    expect(statusEl()?.textContent).toBe('7 pending');
  });

  describe('when the cloud account is disconnected', () => {
    it('does not render a stale successful sync as healthy', () => {
      render(
        {
          ...BASE,
          lastSyncedAt: new Date(Date.now() - 14 * 3_600_000).toISOString(),
          pendingCount: 237,
        },
        false,
      );
      const el = statusEl();
      const text = el?.textContent ?? '';
      expect(text).not.toContain('Synced');
      expect(text).toContain('Sign in to sync');
      expect(text).toContain('237 pending');
      expect(el?.querySelector('[data-dot-tone="success"]')).toBeNull();
      expect(el?.querySelector('[data-dot-tone="danger"]')).not.toBeNull();
    });

    it('reports disconnected rather than waiting when never synced', () => {
      render({ ...BASE, pendingCount: 7 }, false);
      expect(statusEl()?.textContent).toBe('Sign in to sync · 7 pending');
    });

    it('names the disconnection as the cause of a failed upload', () => {
      render(
        {
          ...BASE,
          lastError: 'upload-failed',
          lastErrorAt: new Date(Date.now() - 60_000).toISOString(),
          pendingCount: 2,
        },
        false,
      );
      const text = statusEl()?.textContent ?? '';
      expect(text).toContain('Sign in to sync');
      expect(text).not.toContain('Sync failed');
    });

    it('still reports privacy as enabled ahead of connectivity', () => {
      render({ ...BASE, sharingActive: false, pendingCount: 5 }, false);
      expect(statusEl()?.textContent).toBe('Privacy enabled');
    });
  });

  it('keeps the last-synced label while connectivity is still unknown', () => {
    render(
      {
        ...BASE,
        lastSyncedAt: new Date(Date.now() - 300_000).toISOString(),
        pendingCount: 237,
      },
      null,
    );
    expect(statusEl()?.textContent).toContain('Synced 5m ago');
  });
});
