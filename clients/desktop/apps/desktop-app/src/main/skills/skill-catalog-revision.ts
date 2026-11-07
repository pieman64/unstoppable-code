import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { catalogSha256 } from '@canopy/core-runtime/node/catalog';
import { getLockKey } from './lock-file';
import {
  skillLockEntryString,
  type SkillLockSnapshot,
} from './skill-lock-snapshot';

/**
 * The revision a materialization pins for a skill (CAN-4124 D13):
 * catalogSha256({ version: 1, sourceId, skillName, lock, skillMdSha256 }).
 * Null when SKILL.md cannot be read.
 */
export async function skillCatalogRevision(
  ref: { sourceId: string; skillName: string },
  skillMdPath: string,
  lock: SkillLockSnapshot,
  readFile: (path: string) => Promise<Buffer> = (path) => fs.readFile(path),
): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(skillMdPath);
  } catch {
    return null;
  }
  let lockPart:
    | 'unreadable'
    | {
        skillFolderHash: string | null;
        skillPath: string | null;
        updatedAt: string | null;
      }
    | null = 'unreadable';
  if (lock.state === 'ok') {
    const entry = lock.entries.get(getLockKey(ref.sourceId, ref.skillName));
    lockPart =
      entry === undefined
        ? null
        : {
            skillFolderHash: skillLockEntryString(entry, 'skillFolderHash'),
            skillPath: skillLockEntryString(entry, 'skillPath'),
            updatedAt: skillLockEntryString(entry, 'updatedAt'),
          };
  }
  return catalogSha256({
    version: 1,
    sourceId: ref.sourceId,
    skillName: ref.skillName,
    lock: lockPart,
    skillMdSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
