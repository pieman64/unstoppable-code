// CAN-4070 rule: these goldens were captured on the unchanged instruction-file
// helpers before CAN-4106 moved their policy into core-runtime. They run
// against real temporary directories; only symlink and link calls are faulted,
// and hard links and copies give the same results on every host.
import type * as FsPromises from 'node:fs/promises';
import type * as HardLinkHelpers from './helpers/host-independent-hard-links';
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const hardLinks = jest
    .requireActual<
      typeof HardLinkHelpers
    >('./helpers/host-independent-hard-links')
    .hostIndependentHardLinkOps(actual);
  return {
    ...actual,
    symlink: jest.fn(actual.symlink),
    link: jest.fn(hardLinks.link),
    copyFile: hardLinks.copyFile,
  };
});

import { realpathSync } from 'node:fs';
import { link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isProjectInstructionFileReadable,
  resolveOptionalProjectInstructionFile,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
  writeProjectInstructionFile,
  type ProjectInstructionFile,
} from '@canopy/desktop-shared/node/lib/project-instruction-files';
import { ensureAgentsMdSymlinkOrCopy as ensureSharedAgentsMdSymlinkOrCopy } from '@canopy/desktop-shared/node/lib/worktree-service';
import { linkAgentsMdToClaudeMd } from '@canopy/desktop-shared/node/lib/workspace-source-repo';
import {
  ensureAgentsMdSymlink,
  ensureAgentsMdSymlinkOrCopy,
  hasExpectedAgentsMdSymlinkOrCopy,
} from '../lib/instruction-files';
import {
  LEGACY_MULTI_REPO_GUIDANCE_HEADING,
  MULTI_REPO_GUIDANCE_HEADING,
  mergeMultiRepoGuidance,
} from '../lib/multi-repo-guidance';
import { hostIndependentHardLinkOps } from './helpers/host-independent-hard-links';

const realFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
const hostIndependentLink = hostIndependentHardLinkOps(realFs).link;
const mockedSymlink = jest.mocked(symlink);
const mockedLink = jest.mocked(link);

type Layout = (dir: string) => Promise<void>;

const write = (path: string, content: string): Promise<void> =>
  realFs.writeFile(path, content, 'utf8');

const LAYOUTS: Record<string, Layout> = {
  none: () => Promise.resolve(),
  'agents-only': (dir) => write(join(dir, 'AGENTS.md'), '# Agents'),
  'claude-only': (dir) => write(join(dir, 'CLAUDE.md'), '# Claude'),
  'equal-mirror': async (dir) => {
    await write(join(dir, 'AGENTS.md'), '# Shared');
    await write(join(dir, 'CLAUDE.md'), '# Shared');
  },
  unequal: async (dir) => {
    await write(join(dir, 'AGENTS.md'), '# Agents');
    await write(join(dir, 'CLAUDE.md'), '# Claude');
  },
  'agents-link': async (dir) => {
    await write(join(dir, 'CLAUDE.md'), '# Claude');
    await realFs.symlink('CLAUDE.md', join(dir, 'AGENTS.md'));
  },
  'agents-link-dot-relative': async (dir) => {
    await write(join(dir, 'CLAUDE.md'), '# Claude');
    await realFs.symlink('./CLAUDE.md', join(dir, 'AGENTS.md'));
  },
  'agents-link-dangling': (dir) =>
    realFs.symlink('CLAUDE.md', join(dir, 'AGENTS.md')),
  'claude-link': async (dir) => {
    await write(join(dir, 'AGENTS.md'), '# Agents');
    await realFs.symlink('AGENTS.md', join(dir, 'CLAUDE.md'));
  },
  'claude-link-dangling': (dir) =>
    realFs.symlink('AGENTS.md', join(dir, 'CLAUDE.md')),
  'agents-escape': (dir) =>
    realFs.symlink('../outside.md', join(dir, 'AGENTS.md')),
  'claude-escape': (dir) =>
    realFs.symlink('../outside.md', join(dir, 'CLAUDE.md')),
  'agents-indirect-escape': async (dir) => {
    await write(join(dir, 'CLAUDE.md'), '# Local');
    await realFs.symlink('../escape-target', join(dir, 'escape'));
    await realFs.symlink('escape/../CLAUDE.md', join(dir, 'AGENTS.md'));
  },
  'agents-directory': (dir) => realFs.mkdir(join(dir, 'AGENTS.md')),
  'claude-directory': (dir) => realFs.mkdir(join(dir, 'CLAUDE.md')),
  'agents-broken-alias': (dir) =>
    realFs.symlink('OTHER.md', join(dir, 'AGENTS.md')),
  'both-links': async (dir) => {
    await realFs.symlink('CLAUDE.md', join(dir, 'AGENTS.md'));
    await realFs.symlink('AGENTS.md', join(dir, 'CLAUDE.md'));
  },
  'agents-stale-link': async (dir) => {
    await write(join(dir, 'CLAUDE.md'), '# Claude');
    await write(join(dir, 'OTHER.md'), '# Other');
    await realFs.symlink('OTHER.md', join(dir, 'AGENTS.md'));
  },
};

let root: string;
let sequence = 0;

beforeEach(async () => {
  // mockReset drops call history and any unconsumed *Once faults, so no case
  // inherits another's injected failures or call counts.
  mockedSymlink.mockReset().mockImplementation(realFs.symlink);
  mockedLink.mockReset().mockImplementation(hostIndependentLink);
  root = realpathSync(
    await realFs.mkdtemp(join(tmpdir(), 'instruction-golden-')),
  );
  await write(join(root, 'outside.md'), '# Outside');
  await realFs.mkdir(join(root, 'escape-target'));
  await write(join(root, 'escape-target', 'CLAUDE.md'), '# External');
});

afterEach(async () => {
  await realFs.rm(root, { recursive: true, force: true });
});

async function makeDir(layout: string): Promise<string> {
  const dir = join(root, `case-${++sequence}`);
  await realFs.mkdir(dir);
  await LAYOUTS[layout](dir);
  return dir;
}

function scrub(value: string, dir: string): string {
  return value.split(dir).join('<dir>').split(root).join('<root>');
}

function outcomeOf(error: unknown, dir: string): { error: string } {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  )
    return { error: error.code };
  return {
    error: scrub(error instanceof Error ? error.message : String(error), dir),
  };
}

async function entryState(path: string): Promise<string> {
  try {
    const entry = await realFs.lstat(path);
    if (entry.isSymbolicLink()) return `link -> ${await realFs.readlink(path)}`;
    if (entry.isDirectory()) return 'directory';
    const content = await realFs.readFile(path, 'utf8');
    return `file${entry.nlink > 1 ? ' (hard link)' : ''}: ${content}`;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return 'missing';
    throw error;
  }
}

async function dirState(dir: string): Promise<Record<string, string>> {
  return {
    'AGENTS.md': await entryState(join(dir, 'AGENTS.md')),
    'CLAUDE.md': await entryState(join(dir, 'CLAUDE.md')),
    outside: await entryState(join(root, 'outside.md')),
  };
}

function describeTarget(
  target: ProjectInstructionFile,
  dir: string,
): Record<string, string | boolean> {
  return {
    filePath: scrub(target.filePath, dir),
    exists: target.exists,
    ...(target.aliasPath ? { aliasPath: scrub(target.aliasPath, dir) } : {}),
    ...(target.mirrorPath ? { mirrorPath: scrub(target.mirrorPath, dir) } : {}),
  };
}

async function settle<T>(
  dir: string,
  run: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    return outcomeOf(error, dir);
  }
}

describe('CAN-4106 instruction-file layout golden', () => {
  it.each(Object.keys(LAYOUTS))(
    'pins resolve, readiness, load and save for the %s layout',
    async (layout) => {
      const dir = await makeDir(layout);
      const resolved = await settle(dir, async () =>
        describeTarget(await resolveProjectInstructionFile(dir), dir),
      );
      const optional = await settle(dir, async () => {
        const target = await resolveOptionalProjectInstructionFile(dir);
        return target ? describeTarget(target, dir) : 'unsupported';
      });
      const readable = {
        'AGENTS.md': await settle(dir, () =>
          isProjectInstructionFileReadable(dir, 'AGENTS.md'),
        ),
        'CLAUDE.md': await settle(dir, () =>
          isProjectInstructionFileReadable(dir, 'CLAUDE.md'),
        ),
      };
      const before = await dirState(dir);
      const saved = await settle(dir, async () => {
        await writeProjectInstructionFile(
          await resolveProjectInstructionFile(dir),
          '# Saved',
        );
        return 'saved';
      });
      expect({
        resolved,
        optional,
        readable,
        before,
        saved,
        after: await dirState(dir),
      }).toMatchSnapshot();
    },
  );
});

describe('CAN-4106 instruction restore golden', () => {
  const sources = Object.keys(LAYOUTS);
  const targets = ['none', 'agents-link-dangling', 'claude-link-dangling'];
  it.each(
    sources.flatMap((source) =>
      targets.flatMap((target) =>
        (['darwin', 'win32'] as const).map((platform) => ({
          source,
          target,
          platform,
        })),
      ),
    ),
  )(
    'restores $source into $target on $platform',
    async ({ source, target, platform }) => {
      const sourceDir = await makeDir(source);
      const targetDir = await makeDir(target);
      const result = await settle(targetDir, async () => {
        await restoreProjectInstructionFiles(
          await resolveProjectInstructionFile(sourceDir),
          await resolveProjectInstructionFile(targetDir),
          platform,
        );
        return 'restored';
      });
      expect({ result, target: await dirState(targetDir) }).toMatchSnapshot();
    },
  );

  it.each(
    ['EPERM', 'EACCES', 'ENOTSUP'].flatMap((code) =>
      ['agents-link', 'claude-link'].map((source) => ({ code, source })),
    ),
  )(
    'restores a $source source when symlink fails with $code',
    async ({ code, source }) => {
      const sourceDir = await makeDir(source);
      const targetDir = await makeDir('none');
      mockedSymlink.mockRejectedValueOnce(
        Object.assign(new Error(code), { code }),
      );
      const result = await settle(targetDir, async () => {
        await restoreProjectInstructionFiles(
          await resolveProjectInstructionFile(sourceDir),
          await resolveProjectInstructionFile(targetDir),
          'darwin',
        );
        return 'restored';
      });
      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect({ result, target: await dirState(targetDir) }).toMatchSnapshot();
    },
  );
});

const ALIAS_VARIANTS = {
  'desktop ensureAgentsMdSymlink': (
    dir: string,
    platform: NodeJS.Platform,
  ): Promise<void> => ensureAgentsMdSymlink(dir, platform),
  'desktop ensureAgentsMdSymlinkOrCopy': (
    dir: string,
    platform: NodeJS.Platform,
  ): Promise<void> => ensureAgentsMdSymlinkOrCopy(dir, platform),
  'shared ensureAgentsMdSymlinkOrCopy': (
    dir: string,
    platform: NodeJS.Platform,
  ): Promise<void> => ensureSharedAgentsMdSymlinkOrCopy(dir, platform),
  'shared linkAgentsMdToClaudeMd': (dir: string): Promise<void> =>
    linkAgentsMdToClaudeMd(dir),
} as const;
type AliasVariant = keyof typeof ALIAS_VARIANTS;
const VARIANT_NAMES = Object.keys(ALIAS_VARIANTS) as AliasVariant[];

describe('CAN-4106 AGENTS.md alias variant golden', () => {
  it.each(
    VARIANT_NAMES.flatMap((variant) =>
      Object.keys(LAYOUTS).flatMap((layout) =>
        (['darwin', 'win32'] as const).map((platform) => ({
          variant,
          layout,
          platform,
        })),
      ),
    ),
  )(
    '$variant on $layout ($platform)',
    async ({ variant, layout, platform }) => {
      const dir = await makeDir(layout);
      const expectedBefore = await hasExpectedAgentsMdSymlinkOrCopy(dir);
      const result = await settle(dir, async () => {
        await ALIAS_VARIANTS[variant](dir, platform);
        return 'linked';
      });
      expect({
        expectedBefore,
        result,
        after: await dirState(dir),
        expectedAfter: await hasExpectedAgentsMdSymlinkOrCopy(dir),
      }).toMatchSnapshot();
    },
  );

  it.each(
    VARIANT_NAMES.flatMap((variant) =>
      ['EPERM', 'EACCES', 'ENOTSUP'].flatMap((code) =>
        [false, true].map((linkFails) => ({ variant, code, linkFails })),
      ),
    ),
  )(
    '$variant when symlink fails with $code (hard link fails: $linkFails)',
    async ({ variant, code, linkFails }) => {
      const dir = await makeDir('claude-only');
      mockedSymlink.mockRejectedValueOnce(
        Object.assign(new Error(code), { code }),
      );
      if (linkFails)
        mockedLink.mockRejectedValueOnce(
          Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
        );
      const result = await settle(dir, async () => {
        await ALIAS_VARIANTS[variant](dir, 'darwin');
        return 'linked';
      });
      expect({
        result,
        symlinkCalls: mockedSymlink.mock.calls.length,
        linkCalls: mockedLink.mock.calls.length,
        after: await dirState(dir),
      }).toMatchSnapshot();
    },
  );
});

describe('CAN-4106 multi-repo guidance merge golden', () => {
  const defaults = '# Project\n\nUse the repos folder.\n';
  it.each([
    ['empty', ''],
    ['whitespace', '  \n\n'],
    ['user rules only', '# My rules\n\nKeep tests green.\n'],
    [
      'current block',
      `# My rules\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\nOld guidance\n`,
    ],
    [
      'legacy block',
      `# My rules\n\n${LEGACY_MULTI_REPO_GUIDANCE_HEADING}\n\nOld guidance\n`,
    ],
    ['block only', `${MULTI_REPO_GUIDANCE_HEADING}\n\nOld guidance\n`],
    [
      'both headings',
      `${LEGACY_MULTI_REPO_GUIDANCE_HEADING}\n\nA\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\nB\n`,
    ],
  ])('merges into %s content', (_name, existing) => {
    expect(
      mergeMultiRepoGuidance(existing, defaults)
        .split(MULTI_REPO_GUIDANCE_HEADING)
        .join('<HEADING>')
        .split(LEGACY_MULTI_REPO_GUIDANCE_HEADING)
        .join('<LEGACY_HEADING>'),
    ).toMatchSnapshot();
  });
});
