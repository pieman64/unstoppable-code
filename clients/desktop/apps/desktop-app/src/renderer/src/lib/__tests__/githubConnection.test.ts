import type { CanopyApi } from '@canopy/desktop-shared/types';
import {
  probeGitHubConnected,
  settleGitHubLogin,
} from '@/lib/githubConnection';
import { invalidateGitHubCliStatusCache } from '@/hooks/useGitHubCliStatus';
import { notifyGitHubConnectionChanged } from '@/lib/integrationConnectionEvents';

jest.mock('@/hooks/useGitHubCliStatus', () => ({
  invalidateGitHubCliStatusCache: jest.fn(),
}));
jest.mock('@/lib/integrationConnectionEvents', () => ({
  notifyGitHubConnectionChanged: jest.fn(),
}));

declare global {
  interface Window {
    api: CanopyApi;
  }
}

describe('githubConnection', () => {
  const loadGitHubPat = jest.fn();
  const getGitHubCliStatus = jest.fn();
  const refreshGitHubCredentials = jest.fn();
  const calls: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    (globalThis as { window?: unknown }).window = {
      api: { loadGitHubPat, getGitHubCliStatus, refreshGitHubCredentials },
    };
    loadGitHubPat.mockResolvedValue('');
    getGitHubCliStatus.mockImplementation(() => {
      calls.push('probe');
      return Promise.resolve({ authenticated: false });
    });
    refreshGitHubCredentials.mockImplementation(() => {
      calls.push('refresh');
      return Promise.resolve();
    });
    jest.mocked(invalidateGitHubCliStatusCache).mockImplementation(() => {
      calls.push('invalidate');
    });
    jest.mocked(notifyGitHubConnectionChanged).mockImplementation(() => {
      calls.push('notify');
    });
  });

  describe('probeGitHubConnected', () => {
    it('is connected with only a saved PAT', async () => {
      loadGitHubPat.mockResolvedValue('ghp_token');
      await expect(probeGitHubConnected()).resolves.toBe('connected');
    });

    it('is connected with only a signed-in gh CLI', async () => {
      getGitHubCliStatus.mockResolvedValue({ authenticated: true });
      await expect(probeGitHubConnected()).resolves.toBe('connected');
    });

    it('is connected with both', async () => {
      loadGitHubPat.mockResolvedValue('ghp_token');
      getGitHubCliStatus.mockResolvedValue({ authenticated: true });
      await expect(probeGitHubConnected()).resolves.toBe('connected');
    });

    it('is disconnected only when both sources confirm absence', async () => {
      await expect(probeGitHubConnected()).resolves.toBe('disconnected');
    });

    it('is unknown, not disconnected, when a lookup fails', async () => {
      getGitHubCliStatus.mockRejectedValue(new Error('gh missing'));
      await expect(probeGitHubConnected()).resolves.toBe('unknown');
      getGitHubCliStatus.mockResolvedValue({ authenticated: false });
      loadGitHubPat.mockResolvedValue({ ok: false, reason: 'unreadable' });
      await expect(probeGitHubConnected()).resolves.toBe('unknown');
    });
  });

  describe('settleGitHubLogin', () => {
    it('refreshes, invalidates, notifies, then probes in order', async () => {
      getGitHubCliStatus.mockImplementation(() => {
        calls.push('probe');
        return Promise.resolve({ authenticated: true });
      });
      await expect(settleGitHubLogin()).resolves.toBe('connected');
      expect(calls).toEqual(['refresh', 'invalidate', 'notify', 'probe']);
    });

    it('survives a refresh rejection without claiming success', async () => {
      refreshGitHubCredentials.mockRejectedValue(new Error('offline'));
      await expect(settleGitHubLogin()).resolves.toBe('disconnected');
      expect(invalidateGitHubCliStatusCache).toHaveBeenCalledTimes(1);
      expect(notifyGitHubConnectionChanged).toHaveBeenCalledTimes(1);
    });
  });
});
