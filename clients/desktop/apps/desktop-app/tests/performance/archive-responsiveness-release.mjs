#!/usr/bin/env node

// Focused hidden-window archive measurement for a production desktop build.
// This is an evidence driver, not a CI timing assertion. Build with `pnpm run
// build`, then run the same immutable workload on baseline and candidate:
//   node apps/desktop-app/tests/performance/archive-responsiveness-release.mjs
// Results are written under `.performance/desktop/archive-responsiveness/`.
// A production-compatible local provider fixture is supplied through
// ARCHIVE_RESPONSIVENESS_PROVIDER_ENV_JSON plus PROMPT/EXPECTED_OUTPUT. Without
// all three, the driver records archive/model/composer/resource data but exits
// unaccepted because submission-to-first-output was not measured.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { chatPanelLocator } from '../electron/panelHarness.mjs';
import {
  closeArchiveActivityFixture,
  deleteArchiveActivityWorktree,
  launchArchiveActivityFixture,
} from '../electron/seeders/archiveActivityFixture.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const productionEntry = path.join(repoRoot, 'out', 'main', 'index.js');
const outputRoot = path.join(
  repoRoot,
  '.performance',
  'desktop',
  'archive-responsiveness',
);
const repetitions = Number.parseInt(
  process.env.ARCHIVE_RESPONSIVENESS_REPETITIONS ?? '3',
  10,
);
const fixtureSizes = {
  ordinary: 8 * 1024 * 1024,
  large: 64 * 1024 * 1024,
};
const providerPrompt = process.env.ARCHIVE_RESPONSIVENESS_PROVIDER_PROMPT;
const providerExpectedOutput =
  process.env.ARCHIVE_RESPONSIVENESS_PROVIDER_EXPECTED_OUTPUT;
const providerEnv = process.env.ARCHIVE_RESPONSIVENESS_PROVIDER_ENV_JSON
  ? JSON.parse(process.env.ARCHIVE_RESPONSIVENESS_PROVIDER_ENV_JSON)
  : undefined;

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.max(
        0,
        Math.min(
          sorted.length - 1,
          Math.ceil((percentileValue / 100) * sorted.length) - 1,
        ),
      )
    ] ?? null
  );
}

function summarize(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => Number.isFinite(value));
  return {
    count: values.length,
    median: percentile(values, 50),
    p95: percentile(values, 95),
    maximum: values.length > 0 ? Math.max(...values) : null,
  };
}

function sha256(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex');
}

function readPosixProcessTree(rootPid) {
  if (process.platform === 'win32') return [];
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKb: Number(match[3]),
            cpuPercent: Number(match[4]),
            command: match[5],
          }
        : null;
    })
    .filter(Boolean);
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.ppid) && !included.has(row.pid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => included.has(row.pid));
}

async function installHeartbeat(page) {
  await page.evaluate(() => {
    const state = { maximumDelayMs: 0, expectedAt: performance.now() + 16 };
    const timer = window.setInterval(() => {
      const now = performance.now();
      state.maximumDelayMs = Math.max(
        state.maximumDelayMs,
        Math.max(0, now - state.expectedAt),
      );
      state.expectedAt = now + 16;
    }, 16);
    window.__ARCHIVE_RESPONSIVENESS_HEARTBEAT__ = {
      state,
      stop: () => window.clearInterval(timer),
    };
  });
}

async function stopHeartbeat(page) {
  return page.evaluate(() => {
    const heartbeat = window.__ARCHIVE_RESPONSIVENESS_HEARTBEAT__;
    heartbeat?.stop();
    return heartbeat?.state.maximumDelayMs ?? null;
  });
}

async function runSample(fixtureName, payloadBytes, sequence) {
  const fixture = await launchArchiveActivityFixture(false, {
    buildKind: 'production',
    archivePayloadBytes: payloadBytes,
    env: providerEnv,
  });
  const metrics = [];
  const nativeTreeMetrics = [];
  let sampler;
  try {
    await installHeartbeat(fixture.window);
    sampler = setInterval(() => {
      void fixture.electronApp
        .evaluate(({ app }) => app.getAppMetrics())
        .then((snapshot) => metrics.push(snapshot))
        .catch(() => undefined);
      try {
        nativeTreeMetrics.push(readPosixProcessTree(fixture.supervisedTreePid));
      } catch {
        // Retain a missing sample instead of perturbing the measured flow.
      }
    }, 25);
    sampler.unref?.();

    const archiveStartedAt = performance.now();
    await deleteArchiveActivityWorktree(fixture);
    await fixture.app.selectWorktree(fixture.otherId);
    const panel = chatPanelLocator(fixture.window);
    await expect(panel).toBeVisible();

    const modelStartedAt = performance.now();
    const picker = panel.getByTestId('chat-model-picker');
    await picker.click();
    await fixture.window.getByTestId('chat-model-option-sonnet').click();
    await expect(picker).toContainText('Sonnet', { timeout: 15_000 });
    const modelChangeCompletionMs = performance.now() - modelStartedAt;

    const composerStartedAt = performance.now();
    const composer = panel.getByTestId('chat-composer-input');
    await composer.fill(
      `Archive responsiveness probe ${fixtureName}-${sequence}`,
    );
    await expect(composer).toHaveValue(
      `Archive responsiveness probe ${fixtureName}-${sequence}`,
    );
    const composerInputCompletionMs = performance.now() - composerStartedAt;

    let newTurnSubmissionToFirstOutputMs = null;
    if (providerPrompt && providerExpectedOutput) {
      await composer.fill(providerPrompt);
      const turnStartedAt = performance.now();
      await panel.getByTestId('chat-composer-send').click();
      await expect(panel.getByText(providerExpectedOutput).first()).toBeVisible(
        {
          timeout: 60_000,
        },
      );
      newTurnSubmissionToFirstOutputMs = performance.now() - turnStartedAt;
    }

    const manifestPath = path.join(
      fixture.workspaceRoot,
      'archived-containers',
      fixture.original.id,
      'container.json',
    );
    await expect
      .poll(() => existsSync(manifestPath), { timeout: 120_000 })
      .toBe(true);
    const archiveCompletionMs = performance.now() - archiveStartedAt;
    const rendererMaximumDelayMs = await stopHeartbeat(fixture.window);
    clearInterval(sampler);
    sampler = undefined;

    const flattened = metrics.flat();
    const peakWorkingSetKb = metrics.reduce(
      (maximum, snapshot) =>
        Math.max(
          maximum,
          snapshot.reduce(
            (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
            0,
          ),
        ),
      0,
    );
    const utilityPeakWorkingSetKb = metrics.reduce(
      (maximum, snapshot) =>
        Math.max(
          maximum,
          snapshot
            .filter(
              (metric) =>
                metric.type === 'Utility' || metric.type === 'Service',
            )
            .reduce(
              (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
              0,
            ),
        ),
      0,
    );
    const nativeTreePeakWorkingSetKb = nativeTreeMetrics.reduce(
      (maximum, snapshot) =>
        Math.max(
          maximum,
          snapshot.reduce((total, row) => total + row.rssKb, 0),
        ),
      0,
    );
    const nativeTreePeakCpuPercent = nativeTreeMetrics.reduce(
      (maximum, snapshot) =>
        Math.max(
          maximum,
          snapshot.reduce((total, row) => total + row.cpuPercent, 0),
        ),
      0,
    );
    return {
      fixtureName,
      payloadBytes,
      sequence,
      archiveCompletionMs,
      modelChangeCompletionMs,
      composerInputCompletionMs,
      newTurnSubmissionToFirstOutputMs,
      rendererMaximumDelayMs,
      peakWorkingSetMb: peakWorkingSetKb / 1024,
      utilityPeakWorkingSetMb: utilityPeakWorkingSetKb / 1024,
      nativeTreePeakWorkingSetMb: nativeTreePeakWorkingSetKb / 1024,
      nativeTreePeakCpuPercent,
      observedProcessIds: [...new Set(flattened.map((metric) => metric.pid))],
      observedNativeDescendantIds: [
        ...new Set(nativeTreeMetrics.flat().map((row) => row.pid)),
      ],
    };
  } finally {
    if (sampler) clearInterval(sampler);
    await closeArchiveActivityFixture(fixture);
  }
}

async function main() {
  if (!existsSync(productionEntry)) {
    throw new Error('Missing production build. Run `npm run build` first.');
  }
  if (!Number.isSafeInteger(repetitions) || repetitions < 3) {
    throw new Error('ARCHIVE_RESPONSIVENESS_REPETITIONS must be at least 3.');
  }
  const sourceIdentity = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const samples = [];
  for (let sequence = 0; sequence < repetitions; sequence += 1) {
    for (const [fixtureName, payloadBytes] of Object.entries(fixtureSizes)) {
      samples.push(await runSample(fixtureName, payloadBytes, sequence));
    }
  }
  const result = {
    schemaVersion: 1,
    measurementKind: 'release-like-hidden-production-build',
    accepted:
      Boolean(providerPrompt && providerExpectedOutput && providerEnv) &&
      samples.every((sample) =>
        Number.isFinite(sample.newTurnSubmissionToFirstOutputMs),
      ),
    sourceIdentity,
    buildSha256: sha256(productionEntry),
    generatedAt: new Date().toISOString(),
    workload: {
      repetitions,
      fixtureSizes,
      providerFixtureConfigured: Boolean(
        providerPrompt && providerExpectedOutput && providerEnv,
      ),
      windowVisibility: 'hidden',
    },
    summaries: Object.fromEntries(
      Object.keys(fixtureSizes).map((fixtureName) => {
        const selected = samples.filter(
          (sample) => sample.fixtureName === fixtureName,
        );
        return [
          fixtureName,
          Object.fromEntries(
            [
              'archiveCompletionMs',
              'modelChangeCompletionMs',
              'composerInputCompletionMs',
              'newTurnSubmissionToFirstOutputMs',
              'rendererMaximumDelayMs',
              'peakWorkingSetMb',
              'utilityPeakWorkingSetMb',
              'nativeTreePeakWorkingSetMb',
              'nativeTreePeakCpuPercent',
            ].map((field) => [field, summarize(selected, field)]),
          ),
        ];
      }),
    ),
    samples,
    limitations: [
      ...(process.platform === 'win32'
        ? [
            'Windows native-descendant CPU/RSS collection is not implemented in this driver; Windows acceptance requires a platform process-tree sampler.',
          ]
        : []),
      ...(providerPrompt && providerExpectedOutput && providerEnv
        ? []
        : [
            'No production-compatible local provider fixture was configured, so new-turn-to-first-output is unmeasured and this run is not accepted.',
          ]),
    ],
  };
  mkdirSync(outputRoot, { recursive: true });
  const outputPath = path.join(
    outputRoot,
    `${new Date().toISOString().replaceAll(':', '-')}-${sourceIdentity.slice(0, 12)}.json`,
  );
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${outputPath}\n`);
  if (!result.accepted) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `Archive responsiveness measurement failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
