import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

interface EnsureClaudeWorkspaceTrustOptions {
  configPath?: string;
}

export interface EnsureClaudeWorkspaceTrustResult {
  trustedPath: string;
  updated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function claudeGlobalConfigPath(): string {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  }
  return path.join(homedir(), '.claude.json');
}

async function resolveTrustPath(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function resolveTrustPathAliases(cwd: string, trustedPath: string): string[] {
  if (process.platform !== 'win32') {
    return [trustedPath];
  }

  const paths = [path.resolve(cwd), trustedPath];
  for (const candidate of [...paths]) {
    paths.push(path.win32.normalize(candidate));
    paths.push(candidate.replace(/\\/g, '/'));
  }
  return Array.from(new Set(paths));
}

async function readClaudeConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  if (raw.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Claude global config must be a JSON object.');
  }
  return parsed;
}

async function writeClaudeConfig(
  configPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.claude.json.canopy-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, configPath);
}

let trustWriteQueue: Promise<void> = Promise.resolve();

function enqueueTrustWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = trustWriteQueue.then(work, work);
  trustWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function ensureClaudeWorkspaceTrust(
  cwd: string,
  options: EnsureClaudeWorkspaceTrustOptions = {},
): Promise<EnsureClaudeWorkspaceTrustResult> {
  const trustedPath = await resolveTrustPath(cwd);
  const trustedPaths = resolveTrustPathAliases(cwd, trustedPath);
  const configPath = options.configPath ?? claudeGlobalConfigPath();

  return enqueueTrustWrite(async () => {
    const config = await readClaudeConfig(configPath);
    const projects = isRecord(config.projects) ? { ...config.projects } : {};

    const allTrusted = trustedPaths.every((candidate) => {
      const project = projects[candidate];
      return isRecord(project) && project.hasTrustDialogAccepted === true;
    });
    if (config.hasCompletedOnboarding === true && allTrusted) {
      return { trustedPath, updated: false };
    }

    config.hasCompletedOnboarding = true;
    for (const candidate of trustedPaths) {
      const currentProject = isRecord(projects[candidate])
        ? { ...projects[candidate] }
        : {};
      projects[candidate] = {
        ...currentProject,
        hasTrustDialogAccepted: true,
      };
    }
    config.projects = projects;
    await writeClaudeConfig(configPath, config);
    return { trustedPath, updated: true };
  });
}
