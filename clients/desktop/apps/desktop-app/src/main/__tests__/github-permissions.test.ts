jest.mock('../lib/github-auth', () => ({
  loadStoredPat: jest.fn(),
  loadGhCliToken: jest.fn(),
  resolveGitHubTokenWithSource: jest.fn(),
}));

const mockOctokitRequest = jest.fn();
const mockOctokitConstructor = jest.fn();

jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: jest.fn(
    () =>
      function MockOctokit(
        this: { request: typeof mockOctokitRequest },
        options: { auth: string },
      ): void {
        mockOctokitConstructor(options);
        this.request = mockOctokitRequest;
      },
  ),
}));

import {
  loadGhCliToken,
  loadStoredPat,
  resolveGitHubTokenWithSource,
} from '../lib/github-auth';
import { probeGitHubPermissions } from '../lib/github-permissions';

const mockedLoadStoredPat = jest.mocked(loadStoredPat);
const mockedLoadGhCliToken = jest.mocked(loadGhCliToken);
const mockedResolveToken = jest.mocked(resolveGitHubTokenWithSource);

function setRequestResponse(response: {
  headers: Record<string, string | undefined>;
}): void {
  mockOctokitRequest.mockResolvedValue(response);
}

function setRequestError(error: unknown): void {
  mockOctokitRequest.mockRejectedValue(error);
}

describe('probeGitHubPermissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('source = "pat"', () => {
    it('returns tokenAvailable=false with PAT-specific message when no PAT is stored', async () => {
      mockedLoadStoredPat.mockResolvedValue('');

      const result = await probeGitHubPermissions('pat');

      expect(result.tokenAvailable).toBe(false);
      expect(result.error).toContain('personal access token');
      expect(result.tokenType).toBe('unknown');
      expect(mockedLoadGhCliToken).not.toHaveBeenCalled();
      expect(mockedResolveToken).not.toHaveBeenCalled();
    });

    it('classifies classic PAT and reports granted scopes', async () => {
      mockedLoadStoredPat.mockResolvedValue('ghp_abcdefg');
      setRequestResponse({
        headers: { 'x-oauth-scopes': 'repo, read:org, workflow' },
      });

      const result = await probeGitHubPermissions('pat');

      expect(mockOctokitConstructor).toHaveBeenCalledWith({
        auth: 'ghp_abcdefg',
      });
      expect(result.tokenType).toBe('classic');
      expect(result.scopes).toEqual(['repo', 'read:org', 'workflow']);
      expect(result.canListRepos).toBe(true);
      expect(result.error).toBeNull();
    });

    it('marks fine-grained PAT scopes as unknown', async () => {
      mockedLoadStoredPat.mockResolvedValue('github_pat_xyz');
      setRequestResponse({ headers: { 'x-oauth-scopes': undefined } });

      const result = await probeGitHubPermissions('pat');

      expect(result.tokenType).toBe('fine-grained');
      expect(result.permissions.every((p) => p.state === 'unknown')).toBe(true);
      expect(result.canListRepos).toBe(true);
    });

    it('reports 401 with PAT-specific copy', async () => {
      mockedLoadStoredPat.mockResolvedValue('ghp_bad');
      setRequestError(
        Object.assign(new Error('Unauthorized'), { status: 401 }),
      );

      const result = await probeGitHubPermissions('pat');

      expect(result.error).toContain('personal access token');
      expect(result.error).toContain('401');
    });
  });

  describe('source = "oauth"', () => {
    it('returns tokenAvailable=false with OAuth-specific message when gh is not signed in', async () => {
      mockedLoadGhCliToken.mockResolvedValue('');

      const result = await probeGitHubPermissions('oauth');

      expect(result.tokenAvailable).toBe(false);
      expect(result.tokenType).toBe('gh-cli');
      expect(result.error).toContain('gh CLI');
      expect(mockedLoadStoredPat).not.toHaveBeenCalled();
      expect(mockedResolveToken).not.toHaveBeenCalled();
    });

    it('uses the gh CLI token and labels the type as gh-cli', async () => {
      mockedLoadGhCliToken.mockResolvedValue('gho_abcdefg');
      setRequestResponse({ headers: { 'x-oauth-scopes': 'repo' } });

      const result = await probeGitHubPermissions('oauth');

      expect(mockOctokitConstructor).toHaveBeenCalledWith({
        auth: 'gho_abcdefg',
      });
      expect(result.tokenType).toBe('gh-cli');
      expect(result.canListRepos).toBe(true);
    });

    it('reports 401 with OAuth-specific copy', async () => {
      mockedLoadGhCliToken.mockResolvedValue('gho_bad');
      setRequestError(
        Object.assign(new Error('Unauthorized'), { status: 401 }),
      );

      const result = await probeGitHubPermissions('oauth');

      expect(result.error).toContain('gh CLI');
      expect(result.error).toContain('401');
    });
  });

  describe('source = "any"', () => {
    it('falls back to resolveGitHubTokenWithSource and labels token by resolved source', async () => {
      mockedResolveToken.mockResolvedValue({
        token: 'ghp_resolved',
        source: 'pat',
      });
      setRequestResponse({ headers: { 'x-oauth-scopes': 'repo' } });

      const result = await probeGitHubPermissions('any');

      expect(result.tokenAvailable).toBe(true);
      expect(result.tokenType).toBe('classic');
      expect(mockedLoadStoredPat).not.toHaveBeenCalled();
      expect(mockedLoadGhCliToken).not.toHaveBeenCalled();
    });

    it('emits the generic missing-token message when no source has a token', async () => {
      mockedResolveToken.mockResolvedValue({ token: '', source: 'none' });

      const result = await probeGitHubPermissions('any');

      expect(result.tokenAvailable).toBe(false);
      expect(result.error).toContain('No GitHub token found');
    });
  });
});
