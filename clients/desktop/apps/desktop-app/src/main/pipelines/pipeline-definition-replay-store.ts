import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type {
  PipelineDefinitionReplayLedger,
  PipelineDefinitionReplayStore,
} from '@canopy/core-runtime/node/pipeline';
import { getPipelineDefinitionReplaysFilePath } from '../lib/paths';
import { writeStoreFileDurably } from '../lib/durable-store-write';
import { ensureDir } from './fs-utils';

const operation = z.enum([
  'core.pipeline.definition.upsert',
  'core.pipeline.definition.delete',
  'core.pipeline.definition.duplicate',
  'core.pipeline.definition.setEnabled',
  'core.pipeline.definition.import',
]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(512);
const revision = z.number().int().min(0);

const LedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      operation,
      key: digest,
      fingerprint: digest,
      receipt: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('definition'),
          definitionId: id,
          revision,
          enabled: z.boolean().optional(),
          sourceDefinitionId: id.optional(),
          remoteVersion: z.string().max(256).optional(),
        }),
        z.object({
          kind: z.literal('enablement'),
          definitionId: id,
          revision,
          enabled: z.boolean(),
        }),
        z.object({
          kind: z.literal('result'),
          result: z.record(z.string(), z.unknown()),
        }),
      ]),
    }),
  ),
  expired: z.array(z.object({ operation, key: digest })),
});

/**
 * The definition write receipts the desktop keeps so an idempotency key
 * replays after a restart. A missing file is an empty ledger. An unreadable
 * one is kept beside it as `.unreadable` and the ledger starts empty, so
 * saving never stops working; only keys sent before then lose their replay.
 */
export function createPipelineDefinitionReplayStore(
  filePath: () => string = getPipelineDefinitionReplaysFilePath,
): PipelineDefinitionReplayStore {
  return {
    load: (): Promise<PipelineDefinitionReplayLedger> => {
      try {
        const file = filePath();
        if (!existsSync(file))
          return Promise.resolve({ entries: [], expired: [] });
        let parsed: z.output<typeof LedgerSchema>;
        try {
          parsed = LedgerSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        } catch {
          renameSync(file, `${file}.unreadable`);
          return Promise.resolve({ entries: [], expired: [] });
        }
        return Promise.resolve({
          entries: parsed.entries,
          expired: parsed.expired,
        });
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    save: async (ledger): Promise<void> => {
      const file = filePath();
      ensureDir(dirname(file));
      await writeStoreFileDurably(
        file,
        `${JSON.stringify({ version: 1, ...ledger })}\n`,
      );
    },
  };
}
