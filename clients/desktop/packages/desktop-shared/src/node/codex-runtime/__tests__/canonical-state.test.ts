import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getObservedCanonicalCodexHome,
  observeCanonicalCodexHome,
  resetCanonicalCodexHomeForTests,
} from '../canonical-state';

describe('canonical Codex state', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'codex-canonical-state-'),
    );
    resetCanonicalCodexHomeForTests();
  });

  afterEach(() => {
    resetCanonicalCodexHomeForTests();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('normalizes aliases with realpath semantics', () => {
    const stateDirectory = path.join(temporaryDirectory, 'state');
    const alias = path.join(temporaryDirectory, 'alias');
    fs.mkdirSync(stateDirectory);
    fs.symlinkSync(
      stateDirectory,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const first = observeCanonicalCodexHome(alias);
    const second = observeCanonicalCodexHome(stateDirectory);

    expect(second).toBe(first);
    expect(getObservedCanonicalCodexHome()).toBe(
      fs.realpathSync(stateDirectory),
    );
  });

  it('rejects a worker that reports a different state directory', () => {
    const first = path.join(temporaryDirectory, 'first');
    const second = path.join(temporaryDirectory, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    observeCanonicalCodexHome(first);

    expect(() => observeCanonicalCodexHome(second)).toThrow(
      'different canonical state directory',
    );
  });
});
