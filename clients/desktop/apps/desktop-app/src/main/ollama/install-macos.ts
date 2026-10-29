import { access, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileBounded, quoteAppleScriptString } from './installation';

const MACOS_INSTALL_TIMEOUT_MS = 10 * 60_000;
const OLLAMA_APP_DESTINATION = '/Applications/Ollama.app';
const OLLAMA_APPLE_TEAM_ID = '3MU9H2V9Y9';

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function requireSingleAppPayload(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const apps = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  );
  if (apps.length !== 1 || apps[0]?.name !== 'Ollama.app') {
    throw new Error('The Ollama download did not contain the expected app.');
  }
  return join(extractDir, apps[0].name);
}

/**
 * Whether `codesign -dv --verbose=4` output names Ollama's Developer ID team.
 * The team identifier is pinned because the certificate's display name is the
 * publisher's legal entity, which is not "Ollama".
 */
export function isOllamaMacSignature(signatureText: string): boolean {
  const lines = signatureText.split(/\r?\n/);
  // codesign lists the certificate chain leaf first.
  const signer = lines.find((line) => line.startsWith('Authority='));
  return (
    lines.includes(`TeamIdentifier=${OLLAMA_APPLE_TEAM_ID}`) &&
    signer !== undefined &&
    signer.startsWith('Authority=Developer ID Application: ') &&
    signer.endsWith(` (${OLLAMA_APPLE_TEAM_ID})`)
  );
}

async function verifyCodesign(appPath: string): Promise<void> {
  await execFileBounded(
    'codesign',
    ['--verify', '--deep', '--strict', appPath],
    { timeoutMs: 60_000 },
  );
  await execFileBounded('spctl', ['--assess', '--type', 'execute', appPath], {
    timeoutMs: 60_000,
  });
  const result = await execFileBounded(
    'codesign',
    ['-dv', '--verbose=4', appPath],
    { timeoutMs: 60_000, allowNonZeroExit: true },
  );
  if (!isOllamaMacSignature(`${result.stdout}\n${result.stderr}`)) {
    throw new Error('The Ollama app is not signed by Ollama.');
  }
}

async function moveWithAdminAuthorization(source: string): Promise<void> {
  const suffix = randomUUID();
  const stagedPath = `/Applications/.Ollama.app.installing-${suffix}`;
  const backupPath = `/Applications/.Ollama.app.backup-${suffix}`;
  const script = [
    'do shell script ',
    quoteAppleScriptString(
      [
        'set -e',
        `staged=${shellQuote(stagedPath)}`,
        `backup=${shellQuote(backupPath)}`,
        `destination=${shellQuote(OLLAMA_APP_DESTINATION)}`,
        'backed_up=0',
        'installed=0',
        'rollback() {',
        '  status=$?',
        '  trap - EXIT HUP INT TERM',
        '  if [ "$status" -ne 0 ]; then',
        '    if [ "$installed" -eq 1 ]; then /bin/rm -rf "$destination"; fi',
        '    if [ "$backed_up" -eq 1 ] && [ -e "$backup" ]; then /bin/mv "$backup" "$destination"; fi',
        '  fi',
        '  /bin/rm -rf "$staged"',
        '  exit "$status"',
        '}',
        'trap rollback EXIT',
        "trap 'exit 1' HUP INT TERM",
        '/bin/rm -rf "$staged" "$backup"',
        `/usr/bin/ditto ${shellQuote(source)} "$staged"`,
        'if [ -e "$destination" ]; then /bin/mv "$destination" "$backup"; backed_up=1; fi',
        '/bin/mv "$staged" "$destination"',
        'installed=1',
        '/bin/rm -rf "$backup"',
        'trap - EXIT HUP INT TERM',
      ].join('\n'),
    ),
    ' with administrator privileges',
  ].join('');
  await execFileBounded('osascript', ['-e', script], {
    timeoutMs: MACOS_INSTALL_TIMEOUT_MS,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function replaceWithoutAuthorization(source: string): Promise<void> {
  const suffix = randomUUID();
  const stagedPath = `/Applications/.Ollama.app.installing-${suffix}`;
  const backupPath = `/Applications/.Ollama.app.backup-${suffix}`;
  let movedExisting = false;

  try {
    await execFileBounded('ditto', [source, stagedPath], {
      timeoutMs: MACOS_INSTALL_TIMEOUT_MS,
    });
    if (await pathExists(OLLAMA_APP_DESTINATION)) {
      await rename(OLLAMA_APP_DESTINATION, backupPath);
      movedExisting = true;
    }
    await rename(stagedPath, OLLAMA_APP_DESTINATION);
    if (movedExisting) {
      await rm(backupPath, { force: true, recursive: true }).catch(() => {});
    }
  } catch (error) {
    await rm(stagedPath, { force: true, recursive: true }).catch(() => {});
    if (movedExisting && !(await pathExists(OLLAMA_APP_DESTINATION))) {
      await rename(backupPath, OLLAMA_APP_DESTINATION).catch(() => {});
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function installMacOllamaPackage(
  zipPath: string,
  extractDir: string,
  onVerified?: () => void,
): Promise<string> {
  await mkdir(extractDir, { recursive: true });
  await execFileBounded('ditto', ['-x', '-k', zipPath, extractDir], {
    timeoutMs: MACOS_INSTALL_TIMEOUT_MS,
  });

  const appPath = await requireSingleAppPayload(extractDir);
  await verifyCodesign(appPath);
  onVerified?.();

  if (await isWritable('/Applications')) {
    await replaceWithoutAuthorization(appPath);
  } else {
    await moveWithAdminAuthorization(appPath);
  }

  return join(OLLAMA_APP_DESTINATION, 'Contents', 'Resources', 'ollama');
}
