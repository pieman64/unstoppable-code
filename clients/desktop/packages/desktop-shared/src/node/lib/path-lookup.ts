import fs from 'node:fs';
import path from 'node:path';

export function findExecutableOnPath(
  name: string,
  pathEnv = process.env.PATH ?? '',
): string | null {
  if (!pathEnv) {
    return null;
  }

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
    const hasExt = path.extname(name).length > 0;
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      if (hasExt) {
        candidates.push(path.join(dir, name));
      } else {
        for (const ext of pathExt) {
          candidates.push(path.join(dir, name + ext));
        }
      }
    }
  } else {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      candidates.push(path.join(dir, name));
    }
  }

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        continue;
      }
      if (process.platform !== 'win32') {
        fs.accessSync(candidate, fs.constants.X_OK);
      }
      return fs.realpathSync(candidate);
    } catch {
      // Ignore missing entries.
    }
  }

  return null;
}
