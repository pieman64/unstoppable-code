#!/usr/bin/env node
/**
 * Packaged-fork verification for the code-graph off-main build worker.
 *
 * The Playwright Electron harness (`pnpm run test:electron`) proves the worker
 * fork + web-tree-sitter Emscripten init from a PLAIN filesystem `out/main/`
 * dir, but production packages the worker INSIDE `app.asar` (electron-builder
 * `files: ["out/**"]`, only `node-pty` is `asarUnpack`ed) and the runner forks
 * it via `path.join(__dirname, 'code-graph-build-worker.js')` — an
 * asar-internal path. `utilityProcess.fork` from inside an asar is the
 * highest-risk unproven item, because plain `child_process.fork` cannot read
 * from an asar at all.
 *
 * This script reproduces the production layout directly:
 *   1. Copies the emitted build + fingerprint worker bundles +
 *      `web-tree-sitter` + `typescript` and its `@typescript/old` dependency
 *      into a temp app dir and writes a
 *      minimal Electron `main`.
 *   2. Packs that dir into a real `app.asar` via `@electron/asar`.
 *   3. Launches Electron on the asar. The main forks the asar-internal worker
 *      and posts a real `CodeGraphWorkerBuildRequest` against a tiny generated
 *      source tree (resourcesDir points at the real code-graph resources).
 *   4. Forks it again with a seed-only request that clones and rebinds the
 *      completed graph into a second checkout path.
 *   5. Forks the FINGERPRINT worker with a real
 *      `CodeGraphFingerprintWorkerRequest`. This lane is a distinct bundle and
 *      a distinct failure mode: when the npm `electron` launcher stub leaks
 *      into that bundle, its module body spawns `install.js` at load and the
 *      worker dies before registering a message handler — so the fork exits
 *      without responding instead of replying `{ ok: false }`. The scheduler
 *      swallows that failure in production, so this fork is the only place it
 *      is observable. See `scripts/check-electron-boundary.mjs` for the
 *      build-free CI guard on the same invariant.
 *   6. Asserts all workers reply `{ ok: true }` — proving fork-from-asar,
 *      web-tree-sitter init, packaged eager-seed SQLite execution, and an
 *      Electron-free fingerprint worker. The fingerprint fixture is a real git
 *      repo (init + commit) and is fingerprinted twice, before and after
 *      dirtying a tracked file, so the assertion is that the digest is a
 *      64-char hex that CHANGES with worktree state. Without the `git init`
 *      every `gitOutput()` call inside the worker swallows "not a git
 *      repository" into a 'git-error:' buffer, and a "non-empty string" check
 *      would pass vacuously for any implementation.
 *
 * Exit 0 = round trip succeeded from inside the asar. Nonzero = failure.
 *
 * COVERAGE STATUS — this script is MANUAL / build-dependent, not CI-gated. It
 * requires already-emitted worker bundles and a downloaded Electron binary, so
 * it cannot join the cheap resolution-only lint lane. The automated guard on
 * the same invariant is `pnpm run check:electron-boundary` (build-free, runs on
 * every PR via `lint.yml`), backed by `pnpm run test:dev-scripts` for the
 * entry-list/alias parity in `scripts/lib/utility-worker-entries.test.mjs`.
 * Run this one by hand after `pnpm run build` when touching worker packaging.
 *
 * Usage: pnpm run verify:code-graph:asar-fork
 *        (or: node apps/desktop-app/scripts/verify-code-graph-asar-fork.mjs)
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

// The Electron main, generated into the asar. It forks the SIBLING worker
// (asar-internal) and drives one real build plus one eager-seed round trip.
const SMOKE_MAIN = `const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const { app, utilityProcess } = require('electron');

const WORKER = path.join(__dirname, 'code-graph-build-worker.js');
const FINGERPRINT_WORKER = path.join(
  __dirname,
  'code-graph-fingerprint-worker.js',
);
const RESOURCES_DIR = process.env.SMOKE_RESOURCES_DIR;
const SCRATCH = process.env.SMOKE_SCRATCH;

function emit(payload) {
  process.stdout.write('SMOKE_RESULT ' + JSON.stringify(payload) + '\\n');
}

app.disableHardwareAcceleration();

function runWorker(workerPath, request, serviceName) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], { serviceName });
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) {}
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(
      () => finish(new Error(serviceName + ' timed out')),
      90000,
    );
    child.on('message', (message) => finish(null, message));
    child.on('exit', (exitCode) => {
      finish(new Error(serviceName + ' exited (code ' + exitCode + ') before responding'));
    });
    child.postMessage(request);
  });
}

app.whenReady().then(async () => {
  try {
    const workerInsideAsar = WORKER.includes('.asar' + path.sep) || WORKER.includes('.asar/');
    // A tiny interconnected TS source tree the worker will actually parse.
    const repoDir = path.join(SCRATCH, 'repo');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = (i + 1) % N;
      fs.writeFileSync(
        path.join(srcDir, 'mod' + i + '.ts'),
        'import { fn' + a + ' } from "./mod' + a + '";\\n' +
          'export function fn' + i + '(x: number): number {\\n' +
          '  return fn' + a + '(x) + ' + i + ';\\n' +
          '}\\n',
        'utf8',
      );
    }

    fs.writeFileSync(path.join(srcDir, 'native.swift'), 'func nativeWork() {}');
    fs.writeFileSync(path.join(srcDir, 'schema.prisma'), 'model User {\\n id String @id\\n}');

    // Make the fixture a real git repo. Without this every gitOutput() call in
    // fingerprintCodeGraphWorktree swallows "not a git repository" into a
    // 'git-error:' buffer, so the digest is a hash of error strings and any
    // "non-empty string" assertion passes vacuously.
    const gitEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'Canopy Smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
      GIT_COMMITTER_NAME: 'Canopy Smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
      GIT_CONFIG_GLOBAL: path.join(SCRATCH, 'gitconfig-absent'),
      GIT_CONFIG_SYSTEM: path.join(SCRATCH, 'gitconfig-absent'),
    });
    const git = (args) =>
      cp.spawnSync('git', args, {
        cwd: repoDir,
        encoding: 'utf8',
        env: gitEnv,
      });
    const gitInit = git(['init', '--initial-branch=main']);
    const gitAdd = git(['add', '-A']);
    const gitCommit = git(['commit', '-m', 'smoke fixture']);
    const gitSteps = { init: gitInit, add: gitAdd, commit: gitCommit };
    const gitReady = Object.values(gitSteps).every((r) => r.status === 0);
    // Keep stderr: on a spawn failure (git missing from PATH inside the
    // Electron process) the status is null, and without this a broken fixture
    // surfaces only as an opaque gitReady: false.
    const gitDiagnostics = {};
    for (const [name, result] of Object.entries(gitSteps)) {
      gitDiagnostics[name] = {
        status: result.status,
        stderr: String(result.stderr || '').slice(0, 500),
      };
    }

    const graphDbPath = path.join(SCRATCH, 'graph.db');
    const request = {
      dbPath: graphDbPath,
      worktreeRootPath: repoDir,
      resourcesDir: RESOURCES_DIR,
      repositories: [{ repoId: 'root', rootPath: repoDir }],
      options: {},
    };

    const buildResponse = await runWorker(
      WORKER,
      request,
      'smoke-code-graph-build',
    );
    const verificationDb = new (require('node:sqlite').DatabaseSync)(graphDbPath, { readOnly: true });
    const addedFacts = ['src/native.swift::nativeWork', 'src/schema.prisma::User'].every(name => verificationDb.prepare('SELECT id FROM symbols WHERE qualified_name = ?').get(name));
    verificationDb.close();
    const eagerResponse = await runWorker(
      WORKER,
      {
        operation: 'eager-seed',
        targetDbPath: path.join(SCRATCH, 'eager-graph.db'),
        repositories: [
          { repoId: 'root', rootPath: path.join(SCRATCH, 'second-checkout') },
        ],
        source: { kind: 'base-worktree', dbPath: graphDbPath },
      },
      'smoke-code-graph-eager-seed',
    );
    // Separate bundle, separate failure mode: a leaked npm \`electron\` launcher
    // stub kills this worker at load, so the fork exits without responding
    // rather than replying { ok: false }. Either way this assertion fails.
    const fingerprintResponse = await runWorker(
      FINGERPRINT_WORKER,
      { repositories: [{ repoId: 'root', rootPath: repoDir }] },
      'smoke-code-graph-fingerprint',
    );
    // Dirty a tracked file: a digest that reflects real worktree state must
    // change, while a digest built from 'git-error:' buffers cannot.
    fs.writeFileSync(
      path.join(srcDir, 'mod0.ts'),
      'export function fn0(x) { return x + 999; }\\n',
      'utf8',
    );
    const fingerprintAfterEditResponse = await runWorker(
      FINGERPRINT_WORKER,
      { repositories: [{ repoId: 'root', rootPath: repoDir }] },
      'smoke-code-graph-fingerprint-after-edit',
    );
    const ok = !!(
      buildResponse &&
      buildResponse.ok === true &&
      addedFacts &&
      eagerResponse &&
      eagerResponse.ok === true &&
      (eagerResponse.status === 'seeded' ||
        eagerResponse.status === 'existing') &&
      gitReady &&
      fingerprintResponse &&
      fingerprintResponse.ok === true &&
      typeof fingerprintResponse.fingerprint === 'string' &&
      /^[0-9a-f]{64}$/.test(fingerprintResponse.fingerprint) &&
      fingerprintAfterEditResponse &&
      fingerprintAfterEditResponse.ok === true &&
      typeof fingerprintAfterEditResponse.fingerprint === 'string' &&
      /^[0-9a-f]{64}$/.test(fingerprintAfterEditResponse.fingerprint) &&
      fingerprintAfterEditResponse.fingerprint !==
        fingerprintResponse.fingerprint
    );
    emit({
      ok,
      workerInsideAsar,
      addedFacts,
      workerPath: WORKER,
      fingerprintWorkerPath: FINGERPRINT_WORKER,
      gitReady,
      gitDiagnostics,
      response: buildResponse,
      eagerResponse,
      fingerprintResponse,
      fingerprintAfterEditResponse,
    });
    app.exit(ok ? 0 : 2);
  } catch (err) {
    emit({
      ok: false,
      workerInsideAsar: WORKER.includes('.asar'),
      workerPath: WORKER,
      error: String((err && err.stack) || err),
    });
    app.exit(4);
  }
});
`;

function resolveFirstExisting(candidates, label) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate ${label}. Checked:\n  ${candidates.join('\n  ')}`,
  );
}

function resolveNewestExisting(candidates, label) {
  const existing = candidates.filter(existsSync);
  if (existing.length === 0) {
    return resolveFirstExisting(candidates, label);
  }
  return existing.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
  )[0];
}

// Use the most recently emitted production or E2E worker. The worker esbuild
// pass is identical between them; selecting by freshness avoids accidentally
// verifying a stale `out/` artifact after `build:e2e` (or vice versa).
const workerBundle = resolveNewestExisting(
  [
    path.join(repoRoot, 'out', 'main', 'code-graph-build-worker.js'),
    path.join(repoRoot, 'out-e2e', 'main', 'code-graph-build-worker.js'),
  ],
  'emitted code-graph-build-worker.js (run `pnpm run build` or `pnpm run build:e2e` first)',
);

// Deliberately a sibling of the selected build worker rather than its own
// freshness search: both come from the same esbuild pass, so mixing a fresh
// `out/` bundle with a stale `out-e2e/` one would verify a layout that never
// ships together.
const fingerprintWorkerBundle = resolveFirstExisting(
  [path.join(path.dirname(workerBundle), 'code-graph-fingerprint-worker.js')],
  'emitted code-graph-fingerprint-worker.js beside the selected build worker',
);

const resourcesDir = resolveFirstExisting(
  [
    path.join(
      repoRoot,
      'packages',
      'desktop-shared',
      'resources',
      'code-graph',
    ),
    path.join(repoRoot, '.cache', 'brand', 'canopy', 'resources', 'code-graph'),
  ],
  'code-graph resources (runtime wasm + grammars + queries)',
);

const webTreeSitterDir = path.join(repoRoot, 'node_modules', 'web-tree-sitter');
const typescriptDir = path.join(repoRoot, 'node_modules', 'typescript');
const typescriptOldDir = path.join(
  repoRoot,
  'node_modules',
  '@typescript',
  'old',
);
for (const dir of [webTreeSitterDir, typescriptDir, typescriptOldDir]) {
  if (!existsSync(dir)) {
    throw new Error(`Missing required module dir: ${dir}`);
  }
}

const electronBinary = require('electron');

const scratch = mkdtempSync(path.join(os.tmpdir(), 'cg-asar-fork-'));
const appSrc = path.join(scratch, 'app-src');
const asarPath = path.join(scratch, 'app.asar');
const runtimeScratch = path.join(scratch, 'runtime');

try {
  // ---- 1. Assemble the app that will be packed into the asar --------------
  mkdirSync(appSrc, { recursive: true });
  mkdirSync(runtimeScratch, { recursive: true });
  cpSync(workerBundle, path.join(appSrc, 'code-graph-build-worker.js'));
  cpSync(
    fingerprintWorkerBundle,
    path.join(appSrc, 'code-graph-fingerprint-worker.js'),
  );
  // Pack the externalized runtime deps INSIDE the asar, exactly like
  // electron-builder packs production `node_modules` — so the worker's
  // `require('web-tree-sitter')` / `require('typescript')` resolve from an
  // asar-internal path, not a sibling dir.
  mkdirSync(path.join(appSrc, 'node_modules'), { recursive: true });
  cpSync(
    webTreeSitterDir,
    path.join(appSrc, 'node_modules', 'web-tree-sitter'),
    {
      recursive: true,
    },
  );
  cpSync(typescriptDir, path.join(appSrc, 'node_modules', 'typescript'), {
    recursive: true,
  });
  mkdirSync(path.join(appSrc, 'node_modules', '@typescript'), {
    recursive: true,
  });
  cpSync(
    typescriptOldDir,
    path.join(appSrc, 'node_modules', '@typescript', 'old'),
    { recursive: true },
  );

  writeFileSync(
    path.join(appSrc, 'package.json'),
    JSON.stringify(
      {
        name: 'code-graph-asar-fork-smoke',
        version: '0.0.0',
        main: 'main.cjs',
      },
      null,
      2,
    ),
  );
  const smokeMainPath = path.join(appSrc, 'main.cjs');
  writeFileSync(smokeMainPath, SMOKE_MAIN);

  // SMOKE_MAIN is a template literal in an ESLint-ignored file, so nothing
  // else type-checks or lints it. A syntax error inside it would otherwise
  // surface only as the opaque "no SMOKE_RESULT emitted" after Electron boots.
  const syntaxCheck = spawnSync(process.execPath, ['--check', smokeMainPath], {
    encoding: 'utf8',
  });
  if (syntaxCheck.status !== 0) {
    throw new Error(
      `Generated smoke main is not valid JavaScript:\n${syntaxCheck.stderr || ''}`,
    );
  }

  // ---- 2. Pack into a real app.asar ---------------------------------------
  const asar = require('@electron/asar');
  await asar.createPackage(appSrc, asarPath);
  if (!existsSync(asarPath)) {
    throw new Error('asar package was not created');
  }

  // ---- 3. Launch Electron on the asar and fork the worker from inside it --
  // Strip inherited env that would silently invalidate the premise:
  //   ELECTRON_RUN_AS_NODE (set by default in some Canopy/agent shells) runs
  //     the binary as plain Node, so `require('electron')` in the smoke main
  //     throws and the run fails as the misleading "no SMOKE_RESULT emitted".
  //   ELECTRON_NO_ASAR disables Electron's asar fs patch, so "forks a worker
  //     from inside the asar" evaporates and the smoke would report success
  //     while proving nothing.
  // This test only means anything as a real Electron process reading a real asar.
  const smokeEnv = {
    ...process.env,
    SMOKE_RESOURCES_DIR: resourcesDir,
    SMOKE_SCRATCH: runtimeScratch,
    // Headless; no display needed for a utilityProcess fork.
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  delete smokeEnv.ELECTRON_RUN_AS_NODE;
  delete smokeEnv.ELECTRON_NO_ASAR;

  // Must exceed the worst case the child can legitimately take: four worker
  // round trips at the 90s per-worker timeout inside SMOKE_MAIN. A parent
  // timeout below that budget SIGTERMs a slow-but-correct run and reports it as
  // the opaque "no SMOKE_RESULT emitted" — the same misleading failure this
  // script just removed for ELECTRON_RUN_AS_NODE.
  const parentTimeoutMs = 4 * 90_000 + 60_000;
  const result = spawnSync(electronBinary, [asarPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: parentTimeoutMs,
    env: smokeEnv,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }

  const marker = stdout
    .split('\n')
    .find((line) => line.startsWith('SMOKE_RESULT '));
  if (!marker) {
    if (result.signal === 'SIGTERM') {
      console.error(
        `\n[verify-asar-fork] FAIL: electron was killed by the parent timeout ` +
          `after ${parentTimeoutMs}ms. This is a timeout, not a fork failure — ` +
          'raise parentTimeoutMs or investigate what is slow.',
      );
      process.exit(1);
    }
    console.error(
      `\n[verify-asar-fork] FAIL: no SMOKE_RESULT emitted (electron exit=${result.status}, signal=${result.signal}).`,
    );
    process.exit(1);
  }
  const payload = JSON.parse(marker.slice('SMOKE_RESULT '.length));
  console.error(`\n[verify-asar-fork] ${JSON.stringify(payload)}`);
  if (payload.ok === true && payload.workerInsideAsar === true) {
    console.error(
      '[verify-asar-fork] PASS: forked the asar-internal workers for build, eager-seed, and fingerprint round trips.',
    );
    process.exit(0);
  }
  console.error(
    '[verify-asar-fork] FAIL: workers did not complete the build, eager-seed, and fingerprint operations.',
  );
  process.exit(1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
