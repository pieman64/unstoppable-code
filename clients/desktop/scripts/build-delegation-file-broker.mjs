#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

async function windowsCompilerEnvironment() {
  if (process.env.VCToolsInstallDir) return process.env;
  const programFiles =
    process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!programFiles || !systemRoot)
    throw new Error(
      'The Windows SDK and Visual Studio C++ build tools are required',
    );
  const { stdout } = await run(
    path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'),
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { timeout: 15_000 },
  );
  const installation = stdout.trim();
  if (!path.isAbsolute(installation) || /["%\r\n&|<>^!]/.test(installation))
    throw new Error('Visual Studio C++ build tools were not found');
  const developerCommand = path.join(
    installation,
    'Common7/Tools/VsDevCmd.bat',
  );
  const environment = await run(
    path.join(systemRoot, 'System32/cmd.exe'),
    [
      '/d',
      '/s',
      '/c',
      `"call "${developerCommand}" -no_logo -arch=x64 >nul && set"`,
    ],
    { windowsVerbatimArguments: true, timeout: 30_000, maxBuffer: 1_048_576 },
  );
  return Object.fromEntries(
    environment.stdout.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf('=');
      return separator > 0
        ? [[line.slice(0, separator), line.slice(separator + 1)]]
        : [];
    }),
  );
}

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(
  root,
  'packages/desktop-shared/src/node/delegation/native/file-broker.c',
);
const windowsHeader = path.join(path.dirname(source), 'file-broker-windows.h');
const metadata = JSON.parse(
  await fs.readFile(path.join(root, 'package.json'), 'utf8'),
);
const args = process.argv.slice(2);
if (
  !(
    args.length === 0 ||
    (args.length === 1 && args[0] === '--host') ||
    (args.length === 2 && args[0] === '--targets' && args[1]?.length > 0)
  )
)
  throw new Error('Unexpected file broker build argument');
const targets =
  args[0] === '--targets'
    ? args[1].split(',')
    : [`${process.platform}-${process.arch}`];

for (const target of targets) {
  if (
    ![
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
      'linux-x64',
      'linux-arm64',
    ].includes(target)
  )
    throw new Error(`Unsupported file broker target: ${target}`);
  if (!target.startsWith(`${process.platform}-`))
    throw new Error(`Build ${target} on its target OS`);
  if (target.startsWith('linux-') && target !== `linux-${process.arch}`)
    throw new Error(
      `Build ${target} on a native Linux ${target.slice(6)} host`,
    );
  const directory = path.join(root, '.cache/bin', target);
  const binary = path.join(
    directory,
    target.startsWith('win32-')
      ? 'canopy-file-broker.exe'
      : 'canopy-file-broker',
  );
  const digest = createHash('sha256')
    .update(await fs.readFile(source))
    .update(await fs.readFile(windowsHeader))
    .update(
      JSON.stringify({
        target,
        version: metadata['delegation-file-broker'].version,
      }),
    )
    .digest('hex');
  await fs.mkdir(directory, { recursive: true });
  const marker = path.join(directory, '.delegation-file-broker-source');
  let fresh = false;
  try {
    fresh =
      (await fs.readFile(marker, 'utf8')) === digest &&
      (await fs.stat(binary)).size > 0;
  } catch {
    /* First build. */
  }
  if (fresh) {
    process.stdout.write(`File broker is current: ${target}\n`);
    continue;
  }
  const temporary = `${binary}.${randomUUID()}.tmp${process.platform === 'win32' ? '.exe' : ''}`;
  try {
    if (process.platform === 'win32') {
      // The release/developer build environment supplies the Windows SDK and
      // MSVC developer environment. No runtime compiler is shipped or invoked.
      await run(
        'cl.exe',
        [
          '/nologo',
          '/std:c11',
          '/O2',
          '/W4',
          '/WX',
          '/utf-8',
          '/D_WIN32_WINNT=0x0A00',
          source,
          `/Fe:${temporary}`,
          `/Fo:${temporary}.obj`,
        ],
        {
          cwd: directory,
          env: await windowsCompilerEnvironment(),
          timeout: 60_000,
          maxBuffer: 1_048_576,
        },
      );
    } else {
      const compilerArgs = [
        '-std=c11',
        '-D_POSIX_C_SOURCE=200809L',
        '-D_DARWIN_C_SOURCE',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
      ];
      if (process.platform === 'darwin')
        compilerArgs.push(
          '-arch',
          target.endsWith('arm64') ? 'arm64' : 'x86_64',
        );
      await run('cc', [...compilerArgs, source, '-o', temporary], {
        timeout: 60_000,
        maxBuffer: 1_048_576,
      });
      await fs.chmod(temporary, 0o755);
    }
    await fs.rename(temporary, binary);
    await fs.writeFile(marker, digest);
    process.stdout.write(`Built read-only file broker: ${target}\n`);
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(`${temporary}.obj`, { force: true });
  }
}
