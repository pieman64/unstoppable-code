jest.mock('../pipelines/config-paths', () => ({
  getLoginShellPath: (): string => '/login/bin:/usr/bin',
}));

import { brandEnvCandidates } from '@canopy/desktop-shared/brand/env';
import { buildSharedContainerRunEnv } from '../lib/shared-container-run-env';

describe('shared-container run environment', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('passes only the base allowlist and safe declared values', () => {
    const brandedWorktreeDataName = brandEnvCandidates('WORKTREE_DATA_DIR')[0];
    process.env.HOME = '/Users/recipient';
    process.env.USER = 'recipient';
    process.env.GH_TOKEN = 'canopy-secret';
    process.env.ARBITRARY_USER_VALUE = 'global-value';
    process.env.GIT_ASKPASS = '/tmp/askpass';

    const env = buildSharedContainerRunEnv('container-1', [
      { key: 'DATABASE_URL', value: 'postgres://recipient' },
      { key: 'GH_TOKEN', value: 'forged' },
      { key: 'GIT_ASKPASS', value: 'forged' },
      { key: 'GIT_CONFIG_COUNT', value: '1' },
      { key: 'WORKTREE_DATA_DIR', value: '/private/canopy' },
      { key: brandedWorktreeDataName, value: '/private/branded-canopy' },
      { key: 'NODE_OPTIONS', value: '--require bad.js' },
      { key: 'DYLD_INSERT_LIBRARIES', value: '/tmp/bad.dylib' },
    ]);

    expect(env).toMatchObject({
      PATH: '/login/bin:/usr/bin',
      HOME: '/Users/recipient',
      USER: 'recipient',
      DATABASE_URL: 'postgres://recipient',
    });
    for (const name of [
      'GH_TOKEN',
      'ARBITRARY_USER_VALUE',
      'GIT_ASKPASS',
      'GIT_CONFIG_COUNT',
      'WORKTREE_DATA_DIR',
      brandedWorktreeDataName,
      'NODE_OPTIONS',
      'DYLD_INSERT_LIBRARIES',
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });
});
