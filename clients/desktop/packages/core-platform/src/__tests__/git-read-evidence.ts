import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { release, version } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
/** Uploaded by the PlatformServices job as its `platform-contracts-*` artifact. */
const EVIDENCE_DIR = join(REPO_ROOT, '.cache', 'platform-contracts');

export interface EvidenceRecorder {
  /** Keyed by `name`; carries the running test's full name for `jest-results.json`. */
  record(name: string, observation: unknown): void;
  /** For hooks: `currentTestName` there is the last test's, so none is kept. */
  recordSuite(name: string, observation: unknown): void;
  /** Writes `git-read-<suite>-<platform>.json` in CI, when anything was recorded. */
  flush(): void;
}

function output(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Native observations for the coordinator to cite. Supplementary only: every
 * case still asserts its expectation, and recording happens before asserting
 * so a failing case keeps its observation.
 */
export function evidenceRecorder(suite: string): EvidenceRecorder {
  const cases: Record<string, { test: string | null; observation: unknown }> =
    {};
  const env = (key: string): string | null => process.env[key] ?? null;
  return {
    record(name, observation): void {
      const test = expect.getState().currentTestName ?? null;
      cases[name] = { test, observation };
    },
    recordSuite(name, observation): void {
      cases[name] = { test: null, observation };
    },
    flush(): void {
      if (!process.env.CI || Object.keys(cases).length === 0) return;
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = join(EVIDENCE_DIR, `git-read-${suite}-${process.platform}.json`); // prettier-ignore
      const evidence = {
        schema: 2,
        suite,
        testFile: `packages/core-platform/src/__tests__/git-read-${suite}.test.ts`,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        osVersion: version(),
        node: process.versions.node,
        uv: process.versions.uv,
        // A container or runner user may not own the checkout.
        checkoutHead: output('git', ['-c', 'safe.directory=*', '-C', REPO_ROOT, 'rev-parse', 'HEAD']), // prettier-ignore
        // The first `git` on this process's PATH; suites record any other they run.
        pathGit: output('git', ['--version']),
        run: {
          repository: env('GITHUB_REPOSITORY'),
          workflow: env('GITHUB_WORKFLOW'),
          id: env('GITHUB_RUN_ID'),
          attempt: env('GITHUB_RUN_ATTEMPT'),
          job: env('GITHUB_JOB'),
          sha: env('GITHUB_SHA'),
          ref: env('GITHUB_REF'),
          runnerName: env('RUNNER_NAME'),
          runnerEnvironment: env('RUNNER_ENVIRONMENT'),
          runnerOs: env('RUNNER_OS'),
          runnerArch: env('RUNNER_ARCH'),
          image: env('ImageOS'),
          imageVersion: env('ImageVersion'),
        },
        cases,
      };
      writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
    },
  };
}
