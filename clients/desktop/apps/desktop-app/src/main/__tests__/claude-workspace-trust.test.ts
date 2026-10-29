import type * as FsPromisesModule from 'node:fs/promises';

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    realpath: jest.fn(actual.realpath),
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureClaudeWorkspaceTrust } from '../integration/claude-workspace-trust';

const actualFsPromises =
  jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
const mockedRealpath = jest.mocked(fsPromises.realpath);

function expectedTrustedProjectKeys(
  cwd: string,
  trustedPath: string,
): string[] {
  if (process.platform !== 'win32') {
    return [trustedPath];
  }

  const keys = [path.resolve(cwd), trustedPath];
  for (const candidate of [...keys]) {
    keys.push(path.win32.normalize(candidate));
    keys.push(candidate.replace(/\\/g, '/'));
  }
  return Array.from(new Set(keys));
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('claude-workspace-trust', () => {
  let tempDir: string;
  let worktreeDir: string;
  let configPath: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    mockedRealpath.mockImplementation(actualFsPromises.realpath);
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-claude-trust-'));
    worktreeDir = path.join(tempDir, 'worktree');
    configPath = path.join(tempDir, '.claude.json');
    await writeFile(path.join(tempDir, 'placeholder'), '', 'utf8');
    await rm(worktreeDir, { recursive: true, force: true });
    await mkdir(worktreeDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('marks the resolved worktree path as trusted without clobbering existing config', async () => {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          numStartups: 7,
          projects: {
            '/already/trusted': {
              hasTrustDialogAccepted: true,
              allowedTools: ['Read'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const trustedPath = await fsPromises.realpath(worktreeDir);

    const result = await ensureClaudeWorkspaceTrust(worktreeDir, {
      configPath,
    });

    expect(result).toEqual({
      trustedPath,
      updated: true,
    });
    const config = JSON.parse(
      await readFile(configPath, 'utf8'),
    ) as unknown as {
      hasCompletedOnboarding: boolean;
      numStartups: number;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.numStartups).toBe(7);
    expect(config.projects['/already/trusted']).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['Read'],
    });
    expect(config.projects[trustedPath]).toMatchObject({
      hasTrustDialogAccepted: true,
    });
    for (const key of expectedTrustedProjectKeys(worktreeDir, trustedPath)) {
      expect(config.projects[key]).toMatchObject({
        hasTrustDialogAccepted: true,
      });
    }
  });

  it('is idempotent for an already trusted worktree', async () => {
    const trustedPath = await fsPromises.realpath(worktreeDir);
    const projectEntries: Record<
      string,
      Record<string, unknown>
    > = Object.fromEntries(
      expectedTrustedProjectKeys(worktreeDir, trustedPath).map((key) => [
        key,
        { hasTrustDialogAccepted: true },
      ]),
    );
    projectEntries[trustedPath] = {
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
    };
    await writeFile(
      configPath,
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: projectEntries,
      }),
      'utf8',
    );

    const result = await ensureClaudeWorkspaceTrust(worktreeDir, {
      configPath,
    });

    expect(result).toEqual({
      trustedPath,
      updated: false,
    });
    const config = JSON.parse(
      await readFile(configPath, 'utf8'),
    ) as unknown as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.projects[trustedPath]).toEqual({
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
    });
    for (const key of expectedTrustedProjectKeys(worktreeDir, trustedPath)) {
      expect(config.projects[key]).toMatchObject({
        hasTrustDialogAccepted: true,
      });
    }
  });

  it('sets top-level onboarding when the worktree was already trusted', async () => {
    const trustedPath = await fsPromises.realpath(worktreeDir);
    const projectEntries: Record<
      string,
      Record<string, unknown>
    > = Object.fromEntries(
      expectedTrustedProjectKeys(worktreeDir, trustedPath).map((key) => [
        key,
        { hasTrustDialogAccepted: true },
      ]),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        projects: projectEntries,
      }),
      'utf8',
    );

    const result = await ensureClaudeWorkspaceTrust(worktreeDir, {
      configPath,
    });

    expect(result).toEqual({
      trustedPath,
      updated: true,
    });
    const config = JSON.parse(
      await readFile(configPath, 'utf8'),
    ) as unknown as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.projects[trustedPath]).toEqual({
      hasTrustDialogAccepted: true,
    });
    for (const key of expectedTrustedProjectKeys(worktreeDir, trustedPath)) {
      expect(config.projects[key]).toMatchObject({
        hasTrustDialogAccepted: true,
      });
    }
  });

  it('uses CLAUDE_CONFIG_DIR when no explicit config path is supplied', async () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const trustedPath = await fsPromises.realpath(worktreeDir);

    await expect(ensureClaudeWorkspaceTrust(worktreeDir)).resolves.toEqual({
      trustedPath,
      updated: true,
    });

    const config = JSON.parse(
      await readFile(path.join(tempDir, '.claude.json'), 'utf8'),
    ) as unknown as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.projects[trustedPath]).toEqual({
      hasTrustDialogAccepted: true,
    });
    for (const key of expectedTrustedProjectKeys(worktreeDir, trustedPath)) {
      expect(config.projects[key]).toMatchObject({
        hasTrustDialogAccepted: true,
      });
    }
  });

  it('trusts Windows path aliases when running tests on non-Windows hosts', async () => {
    setPlatform('win32');
    const windowsCwd = 'C:\\Users\\tirish\\worktree';
    const trustedPath = 'C:\\Users\\tirish\\worktree';
    mockedRealpath.mockResolvedValue(trustedPath);

    const result = await ensureClaudeWorkspaceTrust(windowsCwd, {
      configPath,
    });

    expect(result).toEqual({
      trustedPath,
      updated: true,
    });
    const config = JSON.parse(
      await readFile(configPath, 'utf8'),
    ) as unknown as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(config.hasCompletedOnboarding).toBe(true);
    for (const key of expectedTrustedProjectKeys(windowsCwd, trustedPath)) {
      expect(config.projects[key]).toMatchObject({
        hasTrustDialogAccepted: true,
      });
    }
    expect(config.projects['C:/Users/tirish/worktree']).toMatchObject({
      hasTrustDialogAccepted: true,
    });
  });
});
