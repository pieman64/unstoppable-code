import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  STRESS_TRANSCRIPT,
  seedStressTranscript,
} from '../electron/stress-transcript-fixture.mjs';

test('stress transcript summary preserves the configured provider', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'stress-transcript-provider-'),
  );
  try {
    await seedStressTranscript(userDataDir, {
      turns: 1,
      batches: 1,
      finalBytes: 1_000,
      providerType: 'claude',
    });
    const entries = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          STRESS_TRANSCRIPT.workspaceId,
          'work-entries.json',
        ),
        'utf8',
      ),
    );
    assert.equal(entries.entries[0].summary.providerType, 'claude');
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
