import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';

async function resolvePathsInput(
  pathsRaw: string | undefined,
  pathsFile: string | undefined,
): Promise<string[]> {
  const source =
    pathsFile && pathsFile.trim().length > 0
      ? await readFile(pathsFile, 'utf8')
      : (pathsRaw ?? '');
  if (!source.trim()) {
    throw new Error('plan-path-validation requires paths or paths_file');
  }

  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error('paths must be a JSON string array');
  }
  return parsed.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('paths must be a JSON string array');
    }
    return value;
  });
}

export async function runPlanPathValidationAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const baseDir = path.resolve(
      process.cwd(),
      env.INPUT_BASE_DIRECTORY || '.',
    );
    const paths = await resolvePathsInput(
      env.INPUT_PATHS,
      env.INPUT_PATHS_FILE,
    );

    const normalized: string[] = [];
    const invalid: string[] = [];

    for (const value of paths) {
      if (!value || value.includes('\0') || path.isAbsolute(value)) {
        invalid.push(value);
        continue;
      }

      const normalizedPath = path.normalize(value);
      const resolved = path.resolve(baseDir, normalizedPath);
      const relative = path.relative(baseDir, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        invalid.push(value);
        continue;
      }

      normalized.push(normalizedPath);
    }

    setOutput('valid', invalid.length === 0 ? 'true' : 'false');
    setOutput('invalid_count', String(invalid.length));
    setOutput('normalized_paths', JSON.stringify(normalized));

    if (invalid.length > 0) {
      setOutput('invalid_paths', JSON.stringify(invalid));
      throw new Error(
        `plan-path-validation rejected ${String(invalid.length)} path(s)`,
      );
    }
  });
}
