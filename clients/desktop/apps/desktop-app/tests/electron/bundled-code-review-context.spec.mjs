import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { parse, stringify } from 'yaml';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const pipelinePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/desktop-shared/resources/pipelines/code-review-claude.yaml',
);
const pipelineName = 'E2E Bundled GitHub Review Context';

function findArtifact(directory, name) {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findArtifact(entryPath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return entryPath;
    }
  }
  return null;
}

test('desktop dispatch retains resolved GitHub review threads from the bundled collector', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-review-context-ui-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const fixtureDir = path.join(userDataDir, 'review-context-fixture');
  const binDir = path.join(fixtureDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const prFile = path.join(fixtureDir, 'pr.json');
  writeFileSync(
    prFile,
    JSON.stringify({
      pr: { url: 'https://github.com/example/repository/pull/123' },
    }),
  );
  const ghPath = path.join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args[1] ?? '';
let result;
if (endpoint === 'graphql') {
  result = { data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [{
      id: 'PRRT_resolved_finding', isResolved: true,
      comments: { nodes: [
        { databaseId: 7001, body: 'AI finding', author: { login: 'review-bot' },
          path: 'src/auth.ts', line: 42,
          pullRequestReview: { databaseId: 77, author: { login: 'review-bot' },
            state: 'COMMENTED', body: '[//]: # (ud-ai-review)', submittedAt: '2026-09-25T12:00:00Z' } },
        { databaseId: 7002, body: 'Rejected by a human', author: { login: 'human-reviewer' },
          path: 'src/auth.ts', line: 42 },
      ] },
    }],
  } } } } };
} else if (endpoint.includes('/reviews?') || endpoint.includes('/issues/')) {
  result = [[]];
} else {
  throw new Error('Unexpected gh request: ' + args.join(' '));
}
process.stdout.write(JSON.stringify(result));
`,
  );
  chmodSync(ghPath, 0o755);

  // Keep the real bundled collector script, while excluding unrelated GitHub,
  // agent, and report jobs so this UI flow needs no account or network access.
  const bundled = parse(readFileSync(pipelinePath, 'utf8')).pipeline;
  const collector = bundled.jobs.github_review_context;
  delete collector.needs;
  collector.continue_on_error = false;
  delete collector.steps[0].env;
  const yaml = stringify({
    pipeline: {
      name: pipelineName,
      on: { dispatch: {} },
      scope: ['worktree'],
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        PR_STATUS: 'found',
        PR_JSON_FILE: prFile,
      },
      jobs: { github_review_context: collector },
    },
  });
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-bundled-review-context',
    name: pipelineName,
    yaml: yaml.replaceAll('{{BRAND_ENV_PREFIX}}', 'CANOPY'),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    await app.openPipelineDispatchModal(pipelineName);
    await window.getByTestId('pipeline-trigger-modal-run').click();

    const runCard = window
      .locator('[data-testid^="pipeline-run-card-"]')
      .filter({ hasText: pipelineName })
      .first();
    await expect(runCard).toBeVisible({ timeout: 30_000 });
    await expect(runCard).toContainText('success', { timeout: 60_000 });

    const artifactPath = findArtifact(userDataDir, 'review-threads.json');
    expect(artifactPath).not.toBeNull();
    const groups = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(groups).toMatchObject([
      {
        reviewId: 77,
        threads: [
          {
            id: 'PRRT_resolved_finding',
            resolved: true,
            replies: [
              { author: 'human-reviewer', body: 'Rejected by a human' },
            ],
          },
        ],
      },
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
