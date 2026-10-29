import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import { getOAuthFailureMessage } from '../useDetectedMcpServers';

type RevisionedServer = DetectedMcpServerInfo & {
  authErrorRevision?: string;
};

function errorServer(authErrorRevision: string): RevisionedServer {
  return {
    key: 'standalone:server-1:config-1',
    source: 'standalone',
    serverName: 'server-1',
    displayName: 'Server',
    type: 'http',
    enabled: true,
    authStatus: 'error',
    authStatusLabel: 'Error',
    canConnect: true,
    lastError: 'Previous refresh failed',
    authErrorRevision,
  };
}

describe('getOAuthFailureMessage', () => {
  it('ignores only the error revision that preceded the current login attempt', () => {
    expect(
      getOAuthFailureMessage(errorServer('revision-1'), 'revision-1'),
    ).toBeNull();
    expect(
      getOAuthFailureMessage(errorServer('revision-2'), 'revision-1'),
    ).toBe('Previous refresh failed');
  });
});
