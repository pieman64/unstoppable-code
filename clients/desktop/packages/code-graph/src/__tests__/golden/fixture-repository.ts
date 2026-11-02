import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** A file's content, or null to delete it in this commit. */
export type FixtureFiles = Readonly<Record<string, string | null>>;

export interface FixtureCommit {
  message: string;
  /** Tag pointing at this commit, used as a stable diff base. */
  tag?: string;
  files: FixtureFiles;
}

/** The repository id every golden graph uses for the fixture repository. */
export const GOLDEN_REPO_ID = 'golden';

/** The ref the golden reads compare against: the first commit. */
export const GOLDEN_BASE_TAG = 'golden-base';

const BASE_FILES: FixtureFiles = {
  'package.json': `${JSON.stringify(
    {
      name: 'golden-fixture',
      private: true,
      scripts: { build: 'tsc -p .', test: 'jest' },
      dependencies: { lodash: '^4.17.21' },
    },
    null,
    2,
  )}\n`,
  'tsconfig.json': `${JSON.stringify(
    { compilerOptions: { strict: true, outDir: 'out' }, include: ['src'] },
    null,
    2,
  )}\n`,
  'README.md': `# Golden fixture

The [calculator](src/calc.ts) and its [entry point](src/main.ts).

## Usage

Run \`run()\` from [main](src/main.ts).
`,
  'docs/architecture.md': `# Architecture

Requests reach [the handler](../src/main.ts) over IPC.
`,
  'src/channels.ts': `export const FIXTURE_CHANNELS = {
  COMPUTE: 'fixture:compute',
  RESET: 'fixture:reset',
} as const;
`,
  'src/calc.ts': `// NOTE: arithmetic stays pure so every caller can share it.
export function add(left: number, right: number): number {
  return left + right;
}

export function multiply(value: number, times: number): number {
  let total = 0;
  for (let index = 0; index < times; index += 1) {
    total = add(total, value);
  }
  return total;
}

export class Calculator {
  public sum(values: readonly number[]): number {
    return values.reduce((total, value) => add(total, value), 0);
  }

  public product(values: readonly number[]): number {
    return values.reduce((total, value) => multiply(total, value), 1);
  }
}
`,
  'src/main.ts': `import { Calculator, multiply } from './calc';
import { FIXTURE_CHANNELS } from './channels';

export function run(): number {
  const calculator = new Calculator();
  return calculator.sum([1, 2, 3]) + multiply(2, 3);
}

// TODO: register the handler only after the window is ready.
export function register(ipcMain: {
  handle(channel: string, listener: () => number): void;
}): void {
  ipcMain.handle(FIXTURE_CHANNELS.COMPUTE, () => run());
}
`,
  'src/renderer.ts': `import { FIXTURE_CHANNELS } from './channels';

export function requestCompute(ipcRenderer: {
  invoke(channel: string): Promise<number>;
}): Promise<number> {
  return ipcRenderer.invoke(FIXTURE_CHANNELS.COMPUTE);
}
`,
  'src/__tests__/calc.test.ts': `import { add, multiply } from '../calc';

describe('calc', () => {
  it('adds', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('multiplies', () => {
    expect(multiply(2, 3)).toBe(6);
  });
});
`,
  '.github/workflows/ci.yml': `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
`,
};

/**
 * The head commit: changes `multiply`, adds `subtract` and a caller of it, and
 * removes the renderer, so detect-changed and change-impact see a modified,
 * an added and a deleted symbol.
 */
const HEAD_FILES: FixtureFiles = {
  'src/calc.ts': `// NOTE: arithmetic stays pure so every caller can share it.
export function add(left: number, right: number): number {
  return left + right;
}

export function subtract(left: number, right: number): number {
  return add(left, -right);
}

export function multiply(value: number, times: number): number {
  if (times < 0) {
    return subtract(0, multiply(value, -times));
  }
  let total = 0;
  for (let index = 0; index < times; index += 1) {
    total = add(total, value);
  }
  return total;
}

export class Calculator {
  public sum(values: readonly number[]): number {
    return values.reduce((total, value) => add(total, value), 0);
  }

  public product(values: readonly number[]): number {
    return values.reduce((total, value) => multiply(total, value), 1);
  }
}
`,
  'src/report.ts': `import { subtract } from './calc';

export function difference(left: number, right: number): string {
  return \`difference: \${subtract(left, right)}\`;
}
`,
  'src/renderer.ts': null,
};

export const GOLDEN_FIXTURE_COMMITS: readonly FixtureCommit[] = [
  {
    message: 'Add the golden fixture',
    tag: GOLDEN_BASE_TAG,
    files: BASE_FILES,
  },
  { message: 'Change multiply and add subtract', files: HEAD_FILES },
];

const FIXED_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Golden Fixture',
  GIT_AUTHOR_EMAIL: 'golden@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Golden Fixture',
  GIT_COMMITTER_EMAIL: 'golden@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

function git(root: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...FIXED_IDENTITY_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function applyFiles(root: string, files: FixtureFiles): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    if (content === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/**
 * Writes the commits into a fresh Git repository at `root`. Identity and dates
 * are fixed, so commit ids are identical on every machine and run.
 */
export function createFixtureRepository(
  root: string,
  commits: readonly FixtureCommit[] = GOLDEN_FIXTURE_COMMITS,
): { head: string; tags: Record<string, string> } {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  const tags: Record<string, string> = {};
  let head = '';
  for (const commit of commits) {
    applyFiles(root, commit.files);
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '--no-verify', '-m', commit.message]);
    head = git(root, ['rev-parse', 'HEAD']);
    if (commit.tag !== undefined) {
      git(root, ['tag', commit.tag]);
      tags[commit.tag] = head;
    }
  }
  return { head, tags };
}
