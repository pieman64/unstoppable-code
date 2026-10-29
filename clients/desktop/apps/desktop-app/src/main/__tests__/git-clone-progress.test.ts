import {
  estimateClonePercent,
  inferCloneRepoName,
  isGitCloneProgressLine,
  parseGitCloneProgressLine,
  redactRemoteUrlCredentials,
  redactRemoteUrlCredentialsInText,
} from '../lib/git-clone-progress';

describe('parseGitCloneProgressLine', () => {
  it('reads remote counting and compressing phases', () => {
    expect(
      parseGitCloneProgressLine('remote: Counting objects:  45% (450/1000)'),
    ).toEqual({
      phase: 'counting',
      percent: 45,
      processed: 450,
      total: 1000,
      received: null,
      throughput: null,
    });
    expect(
      parseGitCloneProgressLine(
        'remote: Compressing objects: 100% (12/12), done.',
      ),
    ).toMatchObject({ phase: 'compressing', percent: 100 });
    expect(
      parseGitCloneProgressLine('remote: Enumerating objects: 12345, done.'),
    ).toMatchObject({ phase: 'counting', percent: null, processed: 12345 });
  });

  it('reads received size and throughput while receiving objects', () => {
    expect(
      parseGitCloneProgressLine(
        'Receiving objects:  37% (1234/3335), 12.34 MiB | 3.21 MiB/s',
      ),
    ).toEqual({
      phase: 'receiving',
      percent: 37,
      processed: 1234,
      total: 3335,
      received: '12.34 MiB',
      throughput: '3.21 MiB/s',
    });
  });

  it('reads delta resolution and checkout phases', () => {
    expect(
      parseGitCloneProgressLine('Resolving deltas:  80% (80/100)'),
    ).toMatchObject({ phase: 'resolving', percent: 80 });
    expect(
      parseGitCloneProgressLine('Updating files:  50% (10/20)'),
    ).toMatchObject({ phase: 'checkout', percent: 50, total: 20 });
    expect(
      parseGitCloneProgressLine('Checking out files:  25% (1/4)'),
    ).toMatchObject({ phase: 'checkout', percent: 25 });
  });

  it('ignores unrelated output and out-of-range percentages', () => {
    expect(parseGitCloneProgressLine("Cloning into 'repo'...")).toBeNull();
    expect(
      parseGitCloneProgressLine("fatal: repository 'x' not found"),
    ).toBeNull();
    expect(
      parseGitCloneProgressLine('Receiving objects: 450% (1/2)'),
    ).toBeNull();
  });

  it('distinguishes progress noise from meaningful stderr', () => {
    expect(isGitCloneProgressLine("Cloning into 'repo'...")).toBe(true);
    expect(isGitCloneProgressLine('Receiving objects:  1% (1/100)')).toBe(true);
    expect(isGitCloneProgressLine("fatal: repository 'x' not found")).toBe(
      false,
    );
  });
});

describe('inferCloneRepoName', () => {
  it('uses the path of URI, scp, and local remotes without user info', () => {
    expect(inferCloneRepoName('https://user:secret@host/')).toBe('repository');
    expect(inferCloneRepoName('ssh://user:secret@host/org/repo.git')).toBe(
      'repo',
    );
    expect(inferCloneRepoName('git@host:org/repo.git')).toBe('repo');
    expect(inferCloneRepoName('/Users/me/source-repo')).toBe('source-repo');
  });
});

describe('estimateClonePercent', () => {
  it('maps each phase into an ordered band of the overall bar', () => {
    const receivingStart = estimateClonePercent('receiving', 0);
    const receivingEnd = estimateClonePercent('receiving', 100);
    expect(estimateClonePercent('starting', null)).toBe(0);
    expect(estimateClonePercent('counting', 100)).toBeLessThanOrEqual(
      receivingStart,
    );
    expect(receivingEnd).toBeLessThanOrEqual(
      estimateClonePercent('resolving', 0),
    );
    expect(estimateClonePercent('checkout', 100)).toBeLessThan(100);
    expect(estimateClonePercent('finishing', null)).toBeLessThan(100);
  });

  it('uses the start of the band when a phase has no percentage', () => {
    expect(estimateClonePercent('receiving', null)).toBe(
      estimateClonePercent('receiving', 0),
    );
  });
});

describe('redactRemoteUrlCredentials', () => {
  it('removes user info from http(s) remotes', () => {
    expect(
      redactRemoteUrlCredentials('https://user:token@github.com/org/repo.git'),
    ).toBe('https://github.com/org/repo.git');
    expect(
      redactRemoteUrlCredentials('https://ghp_secret@github.com/org/repo'),
    ).toBe('https://github.com/org/repo');
  });

  it('leaves scp-style and credential-free remotes untouched', () => {
    expect(redactRemoteUrlCredentials('git@github.com:org/repo.git')).toBe(
      'git@github.com:org/repo.git',
    );
    expect(redactRemoteUrlCredentials('/Users/me/source-repo')).toBe(
      '/Users/me/source-repo',
    );
  });

  it('removes user info from SSH URI remotes', () => {
    expect(
      redactRemoteUrlCredentials('ssh://user:password@host/org/repo.git'),
    ).toBe('ssh://host/org/repo.git');
  });

  it('removes embedded credentials from explanatory text', () => {
    expect(
      redactRemoteUrlCredentialsInText(
        "fatal: repository 'https://token@host/org/repo.git/' not found; ssh://user:password@host/other",
      ),
    ).toBe(
      "fatal: repository 'https://host/org/repo.git/' not found; ssh://host/other",
    );
  });
});
