import * as path from 'node:path';

/**
 * Convert a logical skill source ID into a directory segment that is valid on
 * the current platform. Source IDs intentionally contain colons, which are
 * reserved in Windows file and directory names.
 */
export function getSkillSourceDirectoryName(
  sourceId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return sourceId;

  const escaped = Array.from(sourceId, (character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || '%<>:"/\\|?*'.includes(character)
      ? `%${codePoint.toString(16).toUpperCase().padStart(2, '0')}`
      : character;
  }).join('');

  return escaped.replace(/[. ]+$/, (value) =>
    Array.from(
      value,
      (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    ).join(''),
  );
}

export function getInstalledSkillDirectory(
  skillsRootDir: string,
  sourceId: string,
  skillName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    skillsRootDir,
    getSkillSourceDirectoryName(sourceId, platform),
    skillName,
  );
}
