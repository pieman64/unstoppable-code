import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import { isE2eBuild } from '../lib/e2e-gate';
import { getWorktreeDataDir } from '../lib/paths';
import { validateId } from '../lib/validation';
import { readPreferencesFileDetailed } from '../lib/preferences-store';
import {
  configureManagedDelegationLifetimeService,
  ManagedDelegationLifetimeService,
} from '../agents/delegation/service';

const specSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string(),
  worktreeId: z.string(),
  chatId: z.string(),
  measuredCap: z.number().int().min(512).max(4096).optional(),
  retained: z.number().int().min(0).max(4096).optional(),
});

/** E2E-only early composition; a normal build never reads the spec or overrides policy. */
export async function seedDelegationLifetimeLimitFixture(
  specPath = process.env.CANOPY_E2E_SEED_LIFETIME_LIMIT_FIXTURE,
): Promise<void> {
  if (!isE2eBuild() || !specPath) return;
  const spec = specSchema.parse(JSON.parse(await readFile(specPath, 'utf8')));
  validateId(spec.projectId, 'projectId');
  validateId(spec.worktreeId, 'worktreeId');
  validateId(spec.chatId, 'chatId');
  const service = new ManagedDelegationLifetimeService({
    measuredCap: spec.measuredCap,
  });
  const preferences = await readPreferencesFileDetailed();
  if (preferences.authority === 'unreadable')
    throw new Error('E2E lifetime preferences are unreadable');
  const count =
    spec.retained ??
    service.normalize(preferences.preferences.managedDelegationLifetimeLimit);
  if (count > service.cap)
    throw new Error('E2E lifetime fixture exceeds its test cap');
  configureManagedDelegationLifetimeService(service);
  const storage = new FileDelegationStorage(
    join(
      getWorktreeDataDir(spec.projectId, spec.worktreeId),
      'delegation',
      'runs',
    ),
  );
  for (let index = 0; index < count; index++) {
    const id = `17000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const record: StoredDelegation = {
      version: 1,
      parent: {
        harnessId: 'claude',
        projectId: spec.projectId,
        worktreeId: spec.worktreeId,
        chatId: spec.chatId,
        sessionKey: `${spec.projectId}/${spec.worktreeId}/${spec.chatId}`,
        turnId: 'lifetime-fixture-turn',
        toolCallId: `retained-${index}`,
        runtimeGeneration: 1,
        depth: 0,
      },
      task: {
        modelId: 'lifetime-fixture-model',
        description: `Retained lifetime fixture ${index + 1}`,
        prompt: 'Retained lifetime fixture; no execution.',
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
      callKey: index.toString(16).padStart(64, '0'),
      requestHash: '1'.repeat(64),
      createdAt: 1_788_825_601_000 + index,
      state: {
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        status: 'completed',
        outputTruncated: false,
        finishedAt: 1_788_825_601_001 + index,
        transcript: [],
      },
      launch: {
        version: 1,
        delegationId: id,
        runGeneration: 1,
        launchKey: index.toString(16).padStart(64, '0'),
        phase: 'settled',
        terminalStatus: 'completed',
      },
      delivery: { status: 'suppressed', reason: 'automatic_delivery_removed' },
    };
    await storage.commit(record);
  }
}
