import { z } from 'zod';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  PersonalProjectOperationSchema,
  type PersonalProjectOperation,
} from '@canopy/protocol/organizations';
import { writeFileAtomically } from './atomic-file';
import { isErrnoException } from './type-guards';

const JournalSchema = z.object({
  version: z.literal(1),
  operations: z.array(PersonalProjectOperationSchema),
});
export interface PersonalOrganizationUpgradeJournal {
  read(): Promise<PersonalProjectOperation[]>;
  update(operation: PersonalProjectOperation): Promise<void>;
}
const writesByPath = new Map<string, Promise<void>>();
export function createPersonalOrganizationUpgradeJournal(
  path: () => string,
): PersonalOrganizationUpgradeJournal {
  async function read(): Promise<PersonalProjectOperation[]> {
    try {
      const parsed = JournalSchema.safeParse(
        JSON.parse(await readFile(path(), 'utf8')),
      );
      if (!parsed.success) throw new Error('Upgrade journal is unreadable');
      return parsed.data.operations;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    }
  }
  return {
    async read(): Promise<PersonalProjectOperation[]> {
      await writesByPath.get(path());
      return read();
    },
    update(operation): Promise<void> {
      const filePath = path();
      const write = (writesByPath.get(filePath) ?? Promise.resolve()).then(
        async () => {
          const current = await read();
          const retained = current.filter(
            (entry) =>
              !(
                entry.accountId === operation.accountId &&
                entry.operationId === operation.operationId
              ),
          );
          // Keep every active/refused recovery record; prune only old completed work.
          const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
          const operations = retained.filter(
            (entry) =>
              entry.projects.some(
                (project) =>
                  project.outcome === 'pending' ||
                  project.outcome === 'converted-private',
              ) || Date.parse(entry.updatedAt) >= cutoff,
          );
          operations.push(PersonalProjectOperationSchema.parse(operation));
          await mkdir(dirname(path()), { recursive: true });
          await writeFileAtomically(
            path(),
            JSON.stringify({ version: 1, operations }),
            { mode: 0o600 },
          );
        },
      );
      const settled = write.catch(() => {});
      writesByPath.set(filePath, settled);
      void settled.then(() => {
        if (writesByPath.get(filePath) === settled)
          writesByPath.delete(filePath);
      });
      return write;
    },
  };
}
