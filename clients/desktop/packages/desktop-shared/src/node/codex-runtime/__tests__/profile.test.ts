import {
  resolveCodexSpawnProfile,
  sanitizeCodexSpawnEnvironment,
  type CodexSpawnProfileRequest,
} from '../profile';

describe('resolveCodexSpawnProfile', () => {
  it('keeps command directories out of the restricted worker environment', () => {
    jest.replaceProperty(process, 'env', {
      HOME: '/canonical/home',
      PATH: '/private/bin',
      GH_TOKEN: 'secret',
    });
    const request = {
      environmentPolicy: 'restricted' as const,
      commandDirectories: ['/trusted/git/bin'],
    };
    const profile = resolveCodexSpawnProfile(request);
    expect(profile.environment.PATH).toBe('');
    expect(profile.environment).not.toHaveProperty('GIT_CONFIG_GLOBAL');
    expect(profile.environment).not.toHaveProperty('GH_TOKEN');
    expect(profile.id).toBe(
      resolveCodexSpawnProfile({
        ...request,
        commandDirectories: ['/other/git/bin'],
      }).id,
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('isolates restricted workers from inherited profiles and captures only runtime essentials', () => {
    jest.replaceProperty(process, 'env', {
      HOME: '/canonical/home',
      CODEX_HOME: '/canonical/codex',
      USERPROFILE: 'C:\\Users\\canonical',
      SystemRoot: 'C:\\Windows',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/runtime',
      PATH: '/private/bundled:/user/bin',
      OPENAI_API_KEY: 'target-secret',
      GH_TOKEN: 'github-secret',
      NODE_OPTIONS: '--require=/private/preload.js',
      HTTPS_PROXY: 'https://private-proxy',
      WORKSPACE_SECRET: 'workspace-secret',
    });
    const request = {
      environmentPolicy: 'restricted' as const,
      includeCanopySecrets: false,
    };
    const restricted = resolveCodexSpawnProfile(request);
    expect(restricted.environment).toEqual({
      HOME: '/canonical/home',
      CODEX_HOME: '/canonical/codex',
      USERPROFILE: 'C:\\Users\\canonical',
      SystemRoot: 'C:\\Windows',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/runtime',
      PATH: '',
    });
    expect(restricted.includeCanopySecrets).toBe(false);
    expect(restricted.id).not.toBe(resolveCodexSpawnProfile().id);
    expect(JSON.stringify(restricted)).not.toContain('secret');
  });

  it('keys restricted workers by the captured environment instead of inheriting later changes', () => {
    jest.replaceProperty(process, 'env', { LANG: 'en_US.UTF-8' });
    const request = {
      environmentPolicy: 'restricted' as const,
      includeCanopySecrets: false,
    };
    const first = resolveCodexSpawnProfile(request);
    process.env.LANG = 'fr_FR.UTF-8';
    const second = resolveCodexSpawnProfile(request);
    expect(first.id).not.toBe(second.id);
    expect(first.environment.LANG).toBe('en_US.UTF-8');
  });

  it.each([
    'PATH',
    'NODE_OPTIONS',
    'GH_TOKEN',
    'OPENAI_API_KEY',
    'SECRET',
    'SystemRoot',
    'WINDIR',
  ])('rejects %s in restricted profile overrides', (key) => {
    const request = {
      environmentPolicy: 'restricted' as const,
      environment: { [key]: 'not-allowed' },
    };
    expect(() => resolveCodexSpawnProfile(request)).toThrow(
      'not allowed in a restricted Codex runtime environment',
    );
  });

  it('rejects managed-secret inheritance in restricted workers', () => {
    const request = {
      environmentPolicy: 'restricted' as const,
      includeCanopySecrets: true,
    };
    expect(() => resolveCodexSpawnProfile(request)).toThrow(
      'Restricted Codex workers cannot inherit managed secrets',
    );
  });

  it('is stable across environment and switch ordering', () => {
    const left: CodexSpawnProfileRequest = {
      environment: { SECOND: 'two', FIRST: 'one' },
      experimentalSwitches: { beta: true, alpha: 'on' },
      configArgs: ['-c', 'feature=true'],
    };
    const right: CodexSpawnProfileRequest = {
      environment: { FIRST: 'one', SECOND: 'two' },
      experimentalSwitches: { alpha: 'on', beta: true },
      configArgs: ['-c', 'feature=true'],
    };

    expect(resolveCodexSpawnProfile(left).id).toBe(
      resolveCodexSpawnProfile(right).id,
    );
  });

  it('keeps semantic config argument ordering in profile identity', () => {
    const left = resolveCodexSpawnProfile({
      configArgs: ['-c', 'feature=true', '-c', 'feature=false'],
    });
    const right = resolveCodexSpawnProfile({
      configArgs: ['-c', 'feature=false', '-c', 'feature=true'],
    });

    expect(left.id).not.toBe(right.id);
  });

  it('keeps managed-secret isolation in profile identity', () => {
    const defaultProfile = resolveCodexSpawnProfile();
    const isolatedProfile = resolveCodexSpawnProfile({
      includeCanopySecrets: false,
    });

    expect(defaultProfile.includeCanopySecrets).toBe(true);
    expect(isolatedProfile.includeCanopySecrets).toBe(false);
    expect(defaultProfile.id).not.toBe(isolatedProfile.id);
  });

  it('does not expose raw environment values in ids or labels', () => {
    const sentinel = 'codex-profile-secret-sentinel';
    const profile = resolveCodexSpawnProfile({
      environment: { PRIVATE_VALUE: sentinel },
    });

    expect(profile.id).not.toContain(sentinel);
    expect(profile.label).not.toContain(sentinel);
  });

  it('does not include thread-scoped capability inputs in its contract', () => {
    const profile = resolveCodexSpawnProfile({
      logicalWorkspaceEnvironmentId: 'workspace-a',
    });

    expect(profile).toEqual(
      expect.objectContaining({
        environment: {},
        configArgs: [],
      }),
    );
    expect(profile).not.toHaveProperty('cwd');
    expect(profile).not.toHaveProperty('model');
    expect(profile).not.toHaveProperty('selectedCapabilityRoots');
    expect(profile).not.toHaveProperty('dynamicTools');
  });

  it.each([
    'HOME',
    'CODEX_HOME',
    'Home',
    'home',
    'codex_home',
    'Codex_Home',
    'USERPROFILE',
    'userprofile',
    'HOMEDRIVE',
    'homepath',
    'HomeShare',
  ])('rejects %s overrides', (key) => {
    expect(() =>
      resolveCodexSpawnProfile({
        environment: { [key]: '/forbidden-override' },
      }),
    ).toThrow(`${key} cannot be overridden`);
  });

  it('sanitizes case-insensitive HOME and CODEX_HOME variants', () => {
    expect(
      sanitizeCodexSpawnEnvironment({
        Home: '/tmp/home',
        home: '/tmp/lower-home',
        codex_home: '/tmp/codex',
        UserProfile: 'C:\\Users\\override',
        homeDrive: 'D:',
        HOMEPATH: '\\Users\\override',
        homeShare: '\\\\server\\users\\override',
        SAFE_VALUE: 'kept',
      }),
    ).toEqual({ SAFE_VALUE: 'kept' });
  });
});
