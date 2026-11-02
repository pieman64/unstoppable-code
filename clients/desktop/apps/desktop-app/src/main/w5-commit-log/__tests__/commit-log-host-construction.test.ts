// Writer construction requires admission (CAN-3797): only the app's default
// host, which waits for its process's host-cohort admission, offline
// maintenance's dedicated host, and the daemon's W5 qualification host, which
// waits for its startup claim or published endpoint (W5b), may construct a W5
// commit-log host in production source. Jest suites and E2E compositions are
// not production.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPOSITORY = resolve(__dirname, '../../../../../..');
const DEFAULT_HOST =
  'apps/desktop-app/src/main/w5-commit-log/commit-log-host.ts';
// Offline maintenance's composition joins this list when CAN-4498 adds its
// surface (Q10); it builds a cold host and never registers as a host.
const MAINTENANCE_COMPOSITIONS: readonly string[] = [];
// Built only after the daemon holds the startup claim (Q8(a)).
const DAEMON_HOST = 'apps/core-daemon/src/w5-host.ts';
const CONSTRUCTION_SITES = [
  DEFAULT_HOST,
  DAEMON_HOST,
  ...MAINTENANCE_COMPOSITIONS,
];
const HOST_CLASS = 'packages/core-runtime/src/node/w5/commit-log-host.ts';
const PORTABLE_REQUEST_HANDLER =
  'packages/core-runtime/src/node/w5/commit-log/worker-requests.ts';
// Offline maintenance's resolve decisions (RX2, CAN-5421).
const RECOVERY_CALLERS: readonly string[] = [
  'apps/desktop-app/src/main/lib/w5-maintenance-decisions.ts',
];
const RECOVERY_NAME =
  '(?:resolveRecovery|retryRecoveryRequiredCommit|abandonRecoveryRequiredCommit)';
// `.name(`, `?.name(` or `['name'](`.
const RECOVERY_CALL = new RegExp(
  String.raw`(?:\.\s*${RECOVERY_NAME}|\[\s*(['"\x60])${RECOVERY_NAME}\1\s*\])\s*\(`,
);
// The request's wire name: only the contract, the handler and the host may
// spell it, so nothing posts the request to the worker past the host.
const RECOVERY_METHOD_LITERAL = new RegExp(
  String.raw`(['"\x60])${RECOVERY_NAME}\1`,
);
const RECOVERY_PROTOCOL = [
  HOST_CLASS,
  PORTABLE_REQUEST_HANDLER,
  'packages/core-runtime/src/node/w5/commit-log/worker-contract.ts',
];
const NOT_PRODUCTION =
  /(?:^|\/)(?:__tests__|__mocks__|tests|fixtures|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Every source tree that can host a W5 writer: both desktop apps, the daemon and all packages. */
function sourceRoots(): string[] {
  const packages = readdirSync(join(REPOSITORY, 'packages')).map((name) =>
    join(REPOSITORY, 'packages', name, 'src'),
  );
  return [
    join(REPOSITORY, 'apps/desktop-app/src'),
    join(REPOSITORY, 'apps/desktop-cli/src'),
    join(REPOSITORY, 'apps/core-daemon/src'),
    ...packages,
  ];
}

function productionSources(): string[] {
  const files: string[] = [];
  for (const source of sourceRoots()) {
    let names: string[];
    try {
      names = readdirSync(source, { recursive: true }).map(String);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = relative(REPOSITORY, join(source, name)).replaceAll(
        '\\',
        '/',
      );
      if (/\.[cm]?[jt]sx?$/.test(path) && !NOT_PRODUCTION.test(path))
        files.push(path);
    }
  }
  return files;
}

const MODULE = String.raw`['"][^'"]*commit-log-host['"]`;
const CONSTRUCTION =
  /\bnew\s+(?:[\w$]+\s*\.\s*)*W5CommitLogHost\s*\(|\bextends\s+(?:[\w$]+\s*\.\s*)*W5CommitLogHost\b/;

function captures(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const global = new RegExp(pattern.source, 'g');
  for (let match = global.exec(text); match; match = global.exec(text))
    found.push(match[1] ?? match[0]);
  return found;
}

/**
 * Value (non-type) bindings of the host class from commit-log-host: named,
 * re-exported, destructured from a dynamic import, or reachable through a
 * namespace import.
 */
function valueImportsOfHost(text: string): string[] {
  const named = [
    new RegExp(String.raw`(?:import|export)\s*\{([^}]*)\}\s*from\s*${MODULE}`),
    new RegExp(
      String.raw`\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*${MODULE}\s*\)`,
    ),
  ].flatMap((pattern) =>
    captures(text, pattern)
      .flatMap((list) => list.split(','))
      .map((name) => name.trim())
      .filter((name) => /^W5CommitLogHost\b/.test(name)),
  );
  const namespaces = [
    new RegExp(
      String.raw`(?:import|export)\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*${MODULE}`,
    ),
    new RegExp(
      String.raw`(?:import|require)\(\s*${MODULE}\s*\)\s*\)?\s*\.\s*W5CommitLogHost\b`,
    ),
  ].flatMap((pattern) => captures(text, pattern));
  return [...named, ...namespaces];
}

const sources = productionSources();

describe('W5 commit-log host construction', () => {
  it('scans production source, including the default host', () => {
    expect(sources).toContain(DEFAULT_HOST);
    expect(sources).toContain(DAEMON_HOST);
    expect(sources).toContain(HOST_CLASS);
    expect(sources).toContain('apps/desktop-app/src/main/index.ts');
    expect(sources.some((path) => path.includes('__tests__'))).toBe(false);
  });

  it('constructs only at the default host and maintenance compositions', () => {
    const sites = sources.filter((path) =>
      CONSTRUCTION.test(readFileSync(join(REPOSITORY, path), 'utf8')),
    );
    expect(sites.sort()).toEqual([...CONSTRUCTION_SITES].sort());
  });

  it('never hands the class to other production modules as a value', () => {
    const leaks = sources
      .filter((path) => !CONSTRUCTION_SITES.includes(path))
      .flatMap((path) =>
        valueImportsOfHost(readFileSync(join(REPOSITORY, path), 'utf8')).map(
          (name) => `${path}: ${name}`,
        ),
      );
    expect(leaks).toEqual([]);
  });

  it('builds the default host once, gated on its admission', () => {
    const text = readFileSync(join(REPOSITORY, DEFAULT_HOST), 'utf8');
    const constructions = captures(
      text,
      /new\s+W5CommitLogHost\s*\(\s*\{([\s\S]*?)\}\s*\)/,
    );
    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toMatch(
      /\badmission:\s*\(\)(?::\s*Promise<void>)?\s*=>\s*desktopW5HostAdmission\(/,
    );
  });

  it('builds the daemon host once, gated on its claim-or-endpoint admission', () => {
    const text = readFileSync(join(REPOSITORY, DAEMON_HOST), 'utf8');
    const constructions = captures(
      text,
      /new\s+W5CommitLogHost\s*\(\s*\{([\s\S]*?)\}\s*\)/,
    );
    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toMatch(/\badmission:\s*options\.admission\b/);
  });

  // RX1: only the worker runs the recovery primitives, and only offline
  // maintenance's resolve decisions (RX2) ask its cold host to.
  it('calls the commit-log recovery requests only from the worker and maintenance', () => {
    const callers = sources.filter((path) =>
      RECOVERY_CALL.test(readFileSync(join(REPOSITORY, path), 'utf8')),
    );
    expect(callers.sort()).toEqual(
      [PORTABLE_REQUEST_HANDLER, ...RECOVERY_CALLERS].sort(),
    );
    const spellers = sources.filter((path) =>
      RECOVERY_METHOD_LITERAL.test(
        readFileSync(join(REPOSITORY, path), 'utf8'),
      ),
    );
    expect(spellers.sort()).toEqual([...RECOVERY_PROTOCOL].sort());
  });

  it('detects recovery calls and wire names, not declarations', () => {
    for (const call of [
      'host.retryRecoveryRequiredCommit(id)',
      'host?.resolveRecovery(id)',
      "host['abandonRecoveryRequiredCommit'](id)",
      'host[ "resolveRecovery" ] (id)',
    ])
      expect(RECOVERY_CALL.test(call)).toBe(true);
    expect(RECOVERY_CALL.test('async resolveRecovery(id: string)')).toBe(false);
    expect(RECOVERY_CALL.test('host[\'resolveRecovery"](id)')).toBe(false);
    expect(
      RECOVERY_METHOD_LITERAL.test(
        "port.postMessage({ id, method: 'retryRecoveryRequiredCommit', args })",
      ),
    ).toBe(true);
    expect(RECOVERY_METHOD_LITERAL.test('log.resolveRecovery(id)')).toBe(false);
  });

  it('detects value imports and ignores type-only ones', () => {
    expect(
      valueImportsOfHost(
        "import { W5CommitLogHost, W5CommitLogHostError } from '../w5-commit-log/commit-log-host';",
      ),
    ).toEqual(['W5CommitLogHost']);
    expect(
      valueImportsOfHost(
        "const { W5CommitLogHost: Host } = await import('./commit-log-host');",
      ),
    ).toEqual(['W5CommitLogHost: Host']);
    expect(
      valueImportsOfHost(
        "export { W5CommitLogHost } from './commit-log-host';\nimport * as Log from '../w5-commit-log/commit-log-host';\nconst Host = (await import('./commit-log-host')).W5CommitLogHost;",
      ),
    ).toHaveLength(3);
    expect(CONSTRUCTION.test('new Log.W5CommitLogHost({})')).toBe(true);
    expect(CONSTRUCTION.test('new W5CommitLogHostError()')).toBe(false);
    expect(
      valueImportsOfHost(
        "import type { W5CommitLogHost } from '../w5-commit-log/commit-log-host';\nimport { type W5CommitLogHost as H } from './commit-log-host';",
      ),
    ).toEqual([]);
  });
});
