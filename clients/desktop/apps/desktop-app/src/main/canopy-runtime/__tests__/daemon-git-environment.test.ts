import { runWithGitRequestContext } from '@canopy/desktop-shared/node/git-request-context';
import {
  getEnhancedEnv,
  registerSecretsEnvInjector,
  registerUserEnvironmentInjector,
  resetLoginShellPathCache,
  setLoginShellProbe,
} from '@canopy/desktop-shared/pipelines/config-paths';
import {
  CANOPY_HOST_EXECUTION_LIMITS,
  CanopyHostExecutionSchema,
} from '@canopy/protocol/canopy-core';
import {
  DaemonGitEnvironmentError,
  daemonGitRequestExecution,
} from '../daemon-git-environment';

// CAN-5496: the environment Electron forwards to daemon-served Git is main's
// token-free runGit environment (V1, q-8 option a), built per request.
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CANOPY_ENV_ENHANCED;
  resetLoginShellPathCache();
  // No real login shell: the managed PATH is whatever main's runGit sees.
  setLoginShellProbe(() => Promise.resolve(undefined));
  registerSecretsEnvInjector(() => ({ GH_TOKEN: 'secret-token' }));
  registerUserEnvironmentInjector(() => ({ GIT_SSH_COMMAND: 'user-ssh' }));
});

afterEach(() => {
  registerSecretsEnvInjector(null);
  registerUserEnvironmentInjector(null);
  setLoginShellProbe(undefined);
  process.env = originalEnv;
});

describe('daemonGitRequestExecution', () => {
  it("forwards main's runGit environment without Canopy secrets or user variables", () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const { childEnvironment } = daemonGitRequestExecution('repository-read');
    expect(childEnvironment.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(childEnvironment.PATH).toBe(
      getEnhancedEnv({ includeCanopySecrets: false, environment: false }).PATH,
    );
    expect(childEnvironment.CANOPY_ENV_ENHANCED).toBe('1');
    expect(childEnvironment).not.toHaveProperty('GH_TOKEN');
    expect(childEnvironment).not.toHaveProperty('GIT_SSH_COMMAND');
    // In process the same call site would see the secret; the daemon never does.
    expect(getEnhancedEnv().GH_TOKEN).toBe('secret-token');
  });

  it('always sets the non-interactive switches', () => {
    process.env.GIT_TERMINAL_PROMPT = '1';
    process.env.GCM_INTERACTIVE = 'always';
    const { childEnvironment } = daemonGitRequestExecution('repository-read');
    expect(childEnvironment.GIT_TERMINAL_PROMPT).toBe('0');
    expect(childEnvironment.GCM_INTERACTIVE).toBe('never');
  });

  it('carries the request attribution of the calling async context', () => {
    const inside = runWithGitRequestContext(
      { source: 'branch-watcher', requestId: 'request-7' },
      () => daemonGitRequestExecution('repository-read'),
    );
    expect(inside.childEnvironment).toMatchObject({
      CANOPY_GIT_REQUEST_SOURCE: 'branch-watcher',
      CANOPY_GIT_REQUEST_ID: 'request-7',
    });
    expect(
      daemonGitRequestExecution('repository-read').childEnvironment,
    ).not.toHaveProperty('CANOPY_GIT_REQUEST_ID');
  });

  it('reads the environment again on every call, keeping nothing', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/first.sock';
    const first = daemonGitRequestExecution('repository-read');
    process.env.SSH_AUTH_SOCK = '/tmp/second.sock';
    const second = daemonGitRequestExecution('repository-read');
    expect(first.childEnvironment.SSH_AUTH_SOCK).toBe('/tmp/first.sock');
    expect(second.childEnvironment.SSH_AUTH_SOCK).toBe('/tmp/second.sock');
    expect(first).not.toBe(second);
  });

  it('drops entries a child environment cannot hold and passes the carrier schema', () => {
    // A plain object here; Windows' process.env can list drive-cwd keys.
    process.env['=C:'] = 'C:\\';
    process.env.CANOPY_NUL_VALUE = 'a\0b';
    const execution = daemonGitRequestExecution('repository-read');
    expect(execution.childEnvironment).not.toHaveProperty('=C:');
    expect(execution.childEnvironment).not.toHaveProperty('CANOPY_NUL_VALUE');
    expect(CanopyHostExecutionSchema.safeParse(execution).success).toBe(true);
  });

  it('refuses an environment over the carrier limits without naming a value', () => {
    process.env.CANOPY_HUGE = `sentinel-${'v'.repeat(CANOPY_HOST_EXECUTION_LIMITS.bytes)}`;
    let error: unknown;
    try {
      daemonGitRequestExecution('repository-read');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DaemonGitEnvironmentError);
    expect(String(error)).not.toContain('sentinel');
    expect(String(error)).not.toContain('CANOPY_HUGE');
  });
});
