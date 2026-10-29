export const SKILL_MAIN_FILE = 'SKILL.md';

export interface SkillFileTreeDirectory {
  name: string;
  path: string;
  dirs: SkillFileTreeDirectory[];
  files: string[];
}

export function skillFileLabel(filePath: string): string {
  const segments = filePath.split('/');
  return segments[segments.length - 1] || filePath;
}

export function buildSkillFileTree(
  paths: readonly string[],
): SkillFileTreeDirectory {
  const root: SkillFileTreeDirectory = {
    name: '',
    path: '',
    dirs: [],
    files: [],
  };
  for (const filePath of paths) {
    const segments = filePath.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const dirPath = segments.slice(0, index + 1).join('/');
      let child = node.dirs.find((entry) => entry.path === dirPath);
      if (!child) {
        child = { name: segments[index], path: dirPath, dirs: [], files: [] };
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push(filePath);
  }
  return root;
}
