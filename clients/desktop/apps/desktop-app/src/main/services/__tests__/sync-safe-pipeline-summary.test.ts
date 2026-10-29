import type { PortalPipelineSummary } from '@canopy/protocol/portal';
import {
  isSensitivePipelineInputName,
  looksLikeCredential,
  sanitizePipelineSummaryForSync,
} from '../sync-safe-pipeline-summary';

const GITHUB_TOKEN = 'ghp_sync_regression_0123456789abcdefghijkl';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

function summary(
  overrides: Partial<PortalPipelineSummary> = {},
): PortalPipelineSummary {
  return {
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-1',
    pipelineId: 'project--deploy.yaml',
    name: 'Deploy',
    description: 'Ships the service',
    source: 'deploy.yaml',
    triggerTypes: ['task_ready'],
    scopes: ['worktree'],
    ...overrides,
  };
}

describe('sanitizePipelineSummaryForSync', () => {
  it('never syncs repository-defined defaults or options, whatever they hold', () => {
    const sanitized = sanitizePipelineSummaryForSync(
      summary({
        taskReadyInputs: {
          pin: { type: 'number', default: 123456 },
          passcode: {
            type: 'string',
            default: 'hunter2',
            options: ['hunter2'],
          },
          database: {
            type: 'string',
            default: 'postgres://app:hunter2@db.internal/app',
            description: 'Connect with postgres://app:hunter2@db.internal',
          },
          branch: { type: 'string', default: 'main', description: 'Branch' },
          dry_run: { type: 'boolean', default: true, required: false },
          region: {
            type: 'choice',
            options: ['eu-west-1', 'us-east-1'],
            default: 'eu-west-1',
            description: 'Where to deploy',
          },
          replicas: { type: 'number', default: 3, min: 1, max: 10 },
        },
        planReadyInputs: {
          api_key: { type: 'string', default: 'looks-harmless' },
          max_iterations: {
            type: 'choice',
            options: ['3', GITHUB_TOKEN],
            default: '3',
            description: 'Maximum refinement passes',
          },
        },
      }),
    );
    const serialized = JSON.stringify(sanitized);
    for (const leaked of [
      '123456',
      'hunter2',
      'main',
      'eu-west-1',
      '"default"',
      '"options"',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(sanitized.taskReadyInputs).toEqual({
      pin: { type: 'number' },
      passcode: { type: 'string' },
      branch: { type: 'string', description: 'Branch' },
      database: { type: 'string' },
      dry_run: { type: 'boolean', required: false },
      region: { type: 'choice', description: 'Where to deploy' },
      replicas: { type: 'number', min: 1, max: 10 },
    });
    expect(sanitized.planReadyInputs).toEqual({
      api_key: { type: 'string' },
      max_iterations: {
        type: 'choice',
        description: 'Maximum refinement passes',
      },
    });
  });

  it('drops credential-like or oversized descriptions and those of credential-named inputs', () => {
    const sanitized = sanitizePipelineSummaryForSync(
      summary({
        description: `Use ${GITHUB_TOKEN} to publish`,
        taskReadyInputs: {
          target: {
            type: 'choice',
            description: `Authorization: Bearer ${GITHUB_TOKEN}`,
          },
          deploy_token: { type: 'string', description: 'For example abc123' },
          notes: { type: 'string', description: 'n'.repeat(513) },
          environment: { type: 'choice', description: 'Where to deploy' },
        },
      }),
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(GITHUB_TOKEN);
    expect(serialized).not.toContain('abc123');
    expect(sanitized.description).toBe('');
    expect(sanitized.taskReadyInputs).toEqual({
      target: { type: 'choice' },
      deploy_token: { type: 'string' },
      notes: { type: 'string' },
      environment: { type: 'choice', description: 'Where to deploy' },
    });
  });

  it('keeps structural metadata and an ordinary pipeline description', () => {
    const value = summary({
      taskReadyInputs: {
        environment: {
          type: 'choice',
          required: true,
          description: 'Where to deploy',
          'hint-hide-ui-option': true,
        },
        replicas: { type: 'number', min: 1, max: 10 },
      },
    });
    expect(sanitizePipelineSummaryForSync(value)).toEqual(value);
  });

  it('classifies input names by whole tokens, not fragments', () => {
    for (const name of [
      'deploy_token',
      'apiKey',
      'API_KEY',
      'ACCESS_KEY',
      'client-secret',
      'privateKey',
      'sshKey',
      'password',
      'auth',
      'GitHubToken',
      'pin',
      'passcode',
      'otp',
      'access_code',
      'verificationCode',
    ]) {
      expect(isSensitivePipelineInputName(name)).toBe(true);
    }
    for (const name of [
      'author',
      'concert',
      'environment',
      'cache_key',
      'keynote',
      'authorized_reviewers',
      'sessionless',
      'pinned_version',
      'zip_code',
    ]) {
      expect(isSensitivePipelineInputName(name)).toBe(false);
    }
  });

  it('recognises well-known credential shapes but not ordinary words', () => {
    for (const value of [
      GITHUB_TOKEN,
      JWT,
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBxY',
      'glpat-abcdefghijklmnopqrst',
      'sk_live_abcdefghijklmnop1234',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-123456789012-abcdefghijkl',
      '-----BEGIN RSA PRIVATE KEY-----',
      'password=hunter2hunter2',
      'sk-abcdefghijklmnopqrstuvwxyz0123',
    ]) {
      expect(looksLikeCredential(value)).toBe(true);
    }
    for (const value of ['staging', 'Ships the service', 'v1.2.3', 'main']) {
      expect(looksLikeCredential(value)).toBe(false);
    }
  });
});
