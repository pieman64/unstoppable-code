// A builtin action runs as its own process. If it can reach the shared W5
// writers it must join the host cohort itself (CAN-3797); remove with the
// cohort when those writers are deleted (CAN-3802).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SOURCE = resolve(__dirname, '../..');
const ACTIONS = resolve(__dirname, '..');
const W5_WRITERS = [
  join(SOURCE, 'node/lib/workspace-service.ts'),
  join(SOURCE, 'node/lib/worktree-service.ts'),
];
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else if (specifier.startsWith('@canopy/desktop-shared/'))
    base = join(SOURCE, specifier.slice('@canopy/desktop-shared/'.length));
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    SPECIFIER.lastIndex = 0;
    for (
      let match = SPECIFIER.exec(text);
      match;
      match = SPECIFIER.exec(text)
    ) {
      const target = resolveImport(file, match[1] ?? '');
      if (target && !seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

function actionFiles(action: string): string[] {
  const directory = join(ACTIONS, action);
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('__tests__'))
    .map((name) => join(directory, name));
}

const actions = readdirSync(ACTIONS).filter(
  (name) =>
    !name.startsWith('_') &&
    name !== '__tests__' &&
    existsSync(join(ACTIONS, name, 'index.ts')),
);

describe('builtin actions that reach the shared W5 writers', () => {
  it('finds the actions and the writers', () => {
    expect(actions).toContain('create-worktree');
    for (const writer of W5_WRITERS) expect(existsSync(writer)).toBe(true);
  });

  it.each(actions)('%s registers its host when it can write W5', (action) => {
    const own = actionFiles(action);
    const closure = reachable(own);
    const writers = W5_WRITERS.filter((writer) => closure.has(writer));
    if (writers.length === 0) return;
    const registers = own.some((file) =>
      /\bregisterW5Host\(/.test(readFileSync(file, 'utf8')),
    );
    expect({
      action,
      writers: writers.map((writer) => relative(SOURCE, writer)),
      registers,
    }).toEqual(expect.objectContaining({ registers: true }));
  });

  it('flags create-worktree as a writer', () => {
    const closure = reachable(actionFiles('create-worktree'));
    expect(W5_WRITERS.every((writer) => closure.has(writer))).toBe(true);
  });
});
