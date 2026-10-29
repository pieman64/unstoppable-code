export const MAX_CUSTOM_SKILL_NAME_LENGTH = 255;

export const MAX_SKILL_FILE_PATH_LENGTH = 512;
export const MAX_SKILL_FILE_PATH_DEPTH = 8;
export const MAX_SKILL_FILE_PATH_SEGMENT_LENGTH = 255;

const WINDOWS_RESERVED_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isWindowsReservedDeviceName(value: string): boolean {
  return WINDOWS_RESERVED_DEVICE_NAME.test(value);
}

/**
 * Validate a skill-directory-relative file path for a multi-file skill
 * (e.g. `references/api.md`). Shared by the renderer editor and the main
 * process so both sides reject the same inputs.
 *
 * The rule is deliberately platform-neutral so a skill authored on macOS can
 * be copied to or recreated on Windows without renaming files. `SKILL.md` at
 * the root is reserved (compared case-insensitively because macOS and Windows
 * filesystems are case-insensitive).
 */
export function getSkillFilePathValidationError(
  filePath: string,
): string | null {
  if (!filePath) {
    return 'File path is required.';
  }
  if (filePath.length > MAX_SKILL_FILE_PATH_LENGTH) {
    return `File path must be at most ${MAX_SKILL_FILE_PATH_LENGTH} characters.`;
  }
  if (filePath.includes('\\')) {
    return 'File path must use forward slashes.';
  }
  if (filePath.startsWith('/') || filePath.endsWith('/')) {
    return 'File path cannot start or end with a slash.';
  }
  const segments = filePath.split('/');
  if (segments.length > MAX_SKILL_FILE_PATH_DEPTH) {
    return `File path can be at most ${MAX_SKILL_FILE_PATH_DEPTH} levels deep.`;
  }
  for (const segment of segments) {
    if (!segment) {
      return 'File path cannot contain empty segments.';
    }
    if (segment.length > MAX_SKILL_FILE_PATH_SEGMENT_LENGTH) {
      return `File names must be at most ${MAX_SKILL_FILE_PATH_SEGMENT_LENGTH} characters.`;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
      return 'File names can only contain letters, numbers, dots, hyphens, and underscores, and must start with a letter or number.';
    }
    if (segment.endsWith('.')) {
      return 'File names cannot end with a dot.';
    }
    if (isWindowsReservedDeviceName(segment)) {
      return 'File names cannot use Windows reserved device names.';
    }
  }
  if (segments[0].toLowerCase() === 'skill.md') {
    return 'SKILL.md is reserved for the main skill file.';
  }
  return null;
}

/**
 * Validate the directory-safe name used by user-authored custom skills.
 *
 * The rule is deliberately platform-neutral so a skill created on macOS can
 * be copied to or recreated on Windows without changing its name.
 */
export function getCustomSkillNameValidationError(name: string): string | null {
  if (!name) {
    return 'Skill name is required.';
  }
  if (name.length > MAX_CUSTOM_SKILL_NAME_LENGTH) {
    return `Skill name must be at most ${MAX_CUSTOM_SKILL_NAME_LENGTH} characters.`;
  }
  if (/[^a-z0-9-]/.test(name)) {
    return 'Skill name can only contain lowercase letters, numbers, and hyphens.';
  }
  if (!/^[a-z0-9]/.test(name)) {
    return 'Skill name must start with a lowercase letter or number.';
  }
  if (!/[a-z0-9]$/.test(name)) {
    return 'Skill name must end with a lowercase letter or number.';
  }
  if (isWindowsReservedDeviceName(name)) {
    return 'Skill name cannot use a Windows reserved device name.';
  }
  return null;
}
