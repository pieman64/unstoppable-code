import path from 'node:path';
import {
  buildCodexDelegationPermissionProfiles,
  CODEX_DELEGATION_READ_ONLY_PROFILE,
  CODEX_DELEGATION_WRITE_PROFILE,
} from '../agents/delegation/codex-sandbox-profile';

// Platform-neutral profile construction with Linux-style fixture paths.
// These assertions cover exact runtime reads, read-only Git metadata, private
// denies, network denial and explicit writes. They do not establish native
// Linux sandbox enforcement; the portable verifier and orchestrator acceptance
// cover that separately, using the helpers staged through PR #6010.
const cwd = '/worktree';
const gitRoot = `${cwd}/.git`;
const gitPrivateRoot = `${gitRoot}/worktrees`;
const gitBinary = '/usr/bin/git';
const gitCore = '/usr/lib/git-core';
const temporaryDirectory = '/tmp/canopy-delegate-abc/tmp';

function delegatedProfiles(
  overrides: Parameters<typeof buildCodexDelegationPermissionProfiles>[0] = {
    cwd,
  },
): ReturnType<typeof buildCodexDelegationPermissionProfiles> {
  const { cwd: overriddenCwd, ...profileOverrides } = overrides;
  return buildCodexDelegationPermissionProfiles({
    cwd: overriddenCwd ?? cwd,
    gitRoots: [gitRoot],
    gitPrivateRoots: [gitPrivateRoot],
    runtimeRoots: [gitBinary, gitCore],
    temporaryDirectory,
    ...profileOverrides,
  });
}

describe('buildCodexDelegationPermissionProfiles construction', () => {
  it('denies network, keeps Git metadata read-only, and writes only the private TMPDIR', () => {
    const profiles = delegatedProfiles();
    const readOnly = profiles[CODEX_DELEGATION_READ_ONLY_PROFILE];
    expect(readOnly).toBeDefined();
    const filesystem = readOnly?.filesystem ?? {};
    expect(readOnly?.network).toEqual({ enabled: false });
    expect(filesystem[cwd]).toBe('read');
    // Exact git runtime paths are read-only grants, never the install prefix.
    expect(filesystem[gitBinary]).toBe('read');
    expect(filesystem[gitCore]).toBe('read');
    expect(filesystem['/usr']).toBeUndefined();
    // Validated Git metadata is readable; sibling admin dirs stay denied.
    expect(filesystem[gitRoot]).toBe('read');
    expect(filesystem[gitPrivateRoot]).toBe('deny');
    // Private paths directly under the working directory stay denied.
    expect(filesystem[`${cwd}/.env`]).toBe('deny');
    expect(filesystem[`${cwd}/.ssh`]).toBe('deny');
    expect(filesystem[`${cwd}/.codex`]).toBe('deny');
    expect(filesystem[`${cwd}/.aws`]).toBe('deny');
    expect(filesystem[`${cwd}/.netrc`]).toBe('deny');
    // The private TMPDIR is the only writable path the profile itself grants.
    // The runtime HOME sibling is provided elsewhere and is not a descendant
    // written through this profile.
    expect(filesystem[temporaryDirectory]).toBe('write');
    const homeSibling = path.posix.join(
      path.posix.dirname(temporaryDirectory),
      'home',
    );
    expect(filesystem[homeSibling]).toBeUndefined();
    expect(
      Object.entries(filesystem).filter(([, access]) => access === 'write'),
    ).toEqual([[temporaryDirectory, 'write']]);
  });

  it('adds explicit write grants only in the write profile, never overriding Git metadata or denies', () => {
    const profiles = delegatedProfiles({
      cwd,
      gitRoots: [gitRoot],
      gitPrivateRoots: [gitPrivateRoot],
      runtimeRoots: [gitBinary, gitCore],
      temporaryDirectory,
      // A real source grant, plus a validated Git metadata root the delegate
      // must never gain write on even if the owner lists it.
      writePaths: [`${cwd}/src`, gitRoot],
    });
    const readOnly = profiles[CODEX_DELEGATION_READ_ONLY_PROFILE];
    const write = profiles[CODEX_DELEGATION_WRITE_PROFILE];
    expect(write).toBeDefined();
    // The read-only profile never carries a write grant.
    expect(readOnly?.filesystem[`${cwd}/src`]).not.toBe('write');
    const filesystem = write?.filesystem ?? {};
    expect(write?.network).toEqual({ enabled: false });
    expect(filesystem[`${cwd}/src`]).toBe('write');
    // The Git metadata root stays read even though it was listed as a write.
    expect(filesystem[gitRoot]).toBe('read');
    expect(filesystem[gitPrivateRoot]).toBe('deny');
    expect(filesystem[temporaryDirectory]).toBe('write');
  });

  it('omits the write profile when no write grant survives the Git metadata filter', () => {
    const profiles = delegatedProfiles({
      cwd,
      gitRoots: [gitRoot],
      gitPrivateRoots: [gitPrivateRoot],
      runtimeRoots: [gitBinary, gitCore],
      temporaryDirectory,
      writePaths: [gitRoot, gitPrivateRoot],
    });
    expect(profiles[CODEX_DELEGATION_WRITE_PROFILE]).toBeUndefined();
    expect(profiles[CODEX_DELEGATION_READ_ONLY_PROFILE]).toBeDefined();
  });
});
