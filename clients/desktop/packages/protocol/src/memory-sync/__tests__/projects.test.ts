import {
  CloudProjectBindingSchema,
  CloudProjectManifestSchema,
  RepoRemoteKeySchema,
  normalizeRepoRemote,
} from '../index';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const INSTANCE_ID = '00000000-0000-4000-8000-0000000000f1';
const REPO_A = '00000000-0000-4000-8000-000000000101';
const REPO_B = '00000000-0000-4000-8000-000000000102';
const AT = '2026-10-27T10:00:00.000Z';

describe('repository fingerprints', () => {
  it('gives every remote spelling of one repository the same key', () => {
    const spellings = [
      'https://github.com/unstoppabledomains/canopy.git',
      'https://github.com/UnstoppableDomains/Canopy',
      'https://user:token@github.com/unstoppabledomains/canopy/',
      'http://www.github.com/unstoppabledomains/canopy',
      'git@github.com:unstoppabledomains/canopy.git',
      'ssh://git@github.com/unstoppabledomains/canopy.git',
      'ssh://git@ssh.github.com:443/unstoppabledomains/canopy.git',
      'git+ssh://git@github.com/unstoppabledomains/canopy',
      '  https://github.com//unstoppabledomains/canopy.git  ',
    ];
    for (const remote of spellings) {
      expect(normalizeRepoRemote(remote)).toEqual({
        host: 'github.com',
        path: 'unstoppabledomains/canopy',
        remoteKey: 'github.com/unstoppabledomains/canopy',
        provider: 'github',
      });
    }
  });

  it('keeps nested group paths on generic hosts', () => {
    expect(
      normalizeRepoRemote('git@gitlab.example.com:Platform/Tools/cli.git'),
    ).toEqual({
      host: 'gitlab.example.com',
      path: 'platform/tools/cli',
      remoteKey: 'gitlab.example.com/platform/tools/cli',
      provider: 'generic',
    });
  });

  it('gives local paths and unsupported remotes no key', () => {
    for (const remote of [
      '',
      '/Users/me/repos/canopy',
      '../canopy',
      'C:/Users/me/canopy',
      'C:\\Users\\me\\canopy',
      'file:///Users/me/canopy',
      'https://github.com/canopy',
      'https://github.com/owner/../repo',
      'ftp://example.com/owner/repo',
      'git@github.com:~/repo',
    ]) {
      expect(normalizeRepoRemote(remote)).toBeNull();
    }
  });

  it('accepts only keys that are already normalized', () => {
    expect(
      RepoRemoteKeySchema.safeParse('github.com/unstoppabledomains/canopy')
        .success,
    ).toBe(true);
    for (const key of [
      'GitHub.com/unstoppabledomains/canopy',
      'www.github.com/unstoppabledomains/canopy',
      'github.com/unstoppabledomains/canopy.git',
      'github.com/canopy',
    ]) {
      expect(RepoRemoteKeySchema.safeParse(key).success).toBe(false);
    }
  });
});

describe('cloud project records', () => {
  it('binds an organization project only together with its organization', () => {
    const binding = {
      version: 1,
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      ownerType: 'organization',
      organizationId: ORG_ID,
      instanceId: INSTANCE_ID,
      bindingGeneration: 2,
      boundAt: AT,
      manifestRevision: 5,
      repoListSource: 'cloud_manifest',
    };
    expect(CloudProjectBindingSchema.safeParse(binding).success).toBe(true);
    expect(
      CloudProjectBindingSchema.safeParse({ ...binding, organizationId: null })
        .success,
    ).toBe(false);
    expect(
      CloudProjectBindingSchema.safeParse({ ...binding, ownerType: 'user' })
        .success,
    ).toBe(false);
  });

  it('gives each repository its own directory in a manifest', () => {
    const repository = (
      repositoryId: string,
      directoryName: string,
    ): Record<string, unknown> => ({
      repositoryId,
      sourceKey: null,
      fingerprint: {
        remoteKey: `github.com/unstoppabledomains/${directoryName.toLowerCase()}`,
        provider: 'github',
        providerRepoId: null,
      },
      defaultBranch: 'develop',
      directoryName,
      ordinal: 0,
    });
    const manifest = {
      projectId: PROJECT_ID,
      revision: 1,
      name: 'canopy-everyting',
      kind: 'code',
      topology: 'multi_repo',
      repoListSource: 'cloud_manifest',
      rootRepositoryId: null,
      repositories: [
        repository(REPO_A, 'canopy'),
        repository(REPO_B, 'agentic-core'),
      ],
      portableConfig: null,
    };
    expect(CloudProjectManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      CloudProjectManifestSchema.safeParse({
        ...manifest,
        repositories: [
          repository(REPO_A, 'canopy'),
          repository(REPO_B, 'Canopy'),
        ],
      }).success,
    ).toBe(false);
    for (const [first, second] of [
      ['repo', 'repo.'],
      ['repo', 'CON'],
    ]) {
      expect(
        CloudProjectManifestSchema.safeParse({
          ...manifest,
          repositories: [repository(REPO_A, first), repository(REPO_B, second)],
        }).success,
      ).toBe(false);
    }
    expect(
      CloudProjectManifestSchema.safeParse({
        ...manifest,
        rootRepositoryId: INSTANCE_ID,
      }).success,
    ).toBe(false);
  });
});
