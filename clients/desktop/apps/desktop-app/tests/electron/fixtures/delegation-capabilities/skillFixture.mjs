// Standalone (non-plugin) custom-skill seeding for
// `managed-delegation-capabilities.spec.mjs`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from '../../seeders/index.mjs';

// `apps/desktop-app/src/main/skills/paths.ts` CUSTOM_SOURCE_ID.
export const CUSTOM_SKILL_SOURCE_ID = 'custom:app';

const FIXED_TIMESTAMP = '2026-09-26T00:00:00.000Z';

// Mirrors `getSkillSourceDirectoryName` in
// `packages/desktop-shared/src/node/skills/paths.ts`: Windows escapes the
// characters its file names reserve, such as the colon in `custom:app`.
export function skillSourceDirectoryName(sourceId) {
  if (process.platform !== 'win32') return sourceId;
  const hex = (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  return Array.from(sourceId, (character) =>
    character.charCodeAt(0) < 32 || '%<>:"/\\|?*'.includes(character)
      ? hex(character)
      : character,
  )
    .join('')
    .replace(/[. ]+$/, (value) => Array.from(value, hex).join(''));
}

function skillsRootDir(userDataDir) {
  return path.join(userDataDir, 'skills');
}

function skillsLockFilePath(userDataDir) {
  return path.join(skillsRootDir(userDataDir), 'skills-lock.json');
}

/**
 * Seed a standalone custom skill directory (`skills/<custom:app>/<name>/SKILL.md`)
 * AND its `skills-lock.json` entry.
 *
 * The lock file is required, not cosmetic: `buildDeferredToolsCatalog`
 * (`apps/desktop-app/src/main/deferred-tools/catalog.ts`) discovers skills
 * through `loadSkills()`, which enumerates `skills-lock.json` entries
 * (`apps/desktop-app/src/main/skills/lock-file.ts` `readLockFile` +
 * `apps/desktop-app/src/main/skills/skill-service.ts` `loadSkills`) rather
 * than scanning the skills directory tree. A skill directory with no lock
 * entry is invisible to List Delegates `{ includeCapabilities: true }` and
 * Search Deferred Tools even though the directory (and its SKILL.md) exists.
 * A skill explicitly selected on a chat tab's `pluginSelections.skillRefs`
 * (the "inherited" path) does not go through this enumeration, but this
 * helper seeds the lock entry unconditionally so the same skill can be used
 * for both inherited and cataloged (explicit/deferred) capability cases.
 */
export function seedCapabilitySkill({
  userDataDir,
  skillName,
  description,
  body = 'Fixture skill content for managed-delegation capability tests.',
}) {
  const sourceDir = path.join(
    skillsRootDir(userDataDir),
    skillSourceDirectoryName(CUSTOM_SKILL_SOURCE_ID),
  );
  const skillDir = path.join(sourceDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  writeFileSync(
    skillMdPath,
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  );

  const lockPath = skillsLockFilePath(userDataDir);
  const lock = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, 'utf8'))
    : { version: 2, skills: {} };
  lock.skills[`${CUSTOM_SKILL_SOURCE_ID}/${skillName}`] = {
    sourceId: CUSTOM_SKILL_SOURCE_ID,
    source: 'Fixture (local)',
    sourceType: 'local',
    sourceUrl: '',
    skillPath: '.',
    skillFolderHash: '',
    installedAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  writeJson(lockPath, lock);

  return {
    skillDir,
    skillMdPath,
    lockPath,
    sourceId: CUSTOM_SKILL_SOURCE_ID,
    skillName,
  };
}
