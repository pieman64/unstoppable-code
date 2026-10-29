/**
 * @capture-keep: reusable visual counterpart to the durable model selector flow
 * @capture-reference: docs/ui-automation.md
 * CAN-2701 empty-chat model selection feedback and delayed acknowledgement.
 * Seeded local chats and a gated IPC handler make both captures deterministic.
 * Run MODEL_SELECTION_STAGE=before (or after, the default) with:
 * pnpm run test:electron:captures:built can-2701-model-selection-feedback.capture-spec.ts --reporter=line
 * Repeat with --dark-mode for the dark capture. No live agents or network.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  launchPendingModelFixture,
  releasePendingModel,
} from './model-selection-fixture.mjs';

const stage =
  process.env.MODEL_SELECTION_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright/model-selection');

test('captures model selection while persistence is delayed', async () => {
  const fixture = await launchPendingModelFixture();
  try {
    mkdirSync(captureDir, { recursive: true });
    await fixture.picker
      .locator('xpath=ancestor::*[@data-composer-toolbar-rail]')
      .screenshot({
        path: path.join(captureDir, `pending-selection-${stage}.png`),
        animations: 'disabled',
      });
  } finally {
    await releasePendingModel(fixture.electronApp);
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});
