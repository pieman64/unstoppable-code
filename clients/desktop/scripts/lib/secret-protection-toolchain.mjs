/** Prerequisite probes only: compiler/link failures are never optional. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class SecretProtectionToolchainUnavailable extends Error {}

export function secretProtectionUnavailableReason() {
  if (process.platform === 'win32') {
    // Use the same discovery as node-gyp, without configuring or compiling.
    const gyp = dirname(
      fileURLToPath(import.meta.resolve('node-gyp/package.json')),
    );
    for (const [module, method, args, prerequisite] of [
      [
        'find-python',
        'findPython',
        [process.env.npm_config_python],
        'Python for node-gyp',
      ],
      [
        'find-visualstudio',
        'findVisualStudio',
        [
          { major: Number(process.versions.node.split('.')[0]) },
          process.env.npm_config_msvs_version,
        ],
        'MSVC and Windows SDK for node-gyp',
      ],
    ]) {
      try {
        execFileSync(
          process.execPath,
          [
            '-e',
            `require(${JSON.stringify(join(gyp, 'lib', `${module}.js`))})[${JSON.stringify(method)}](...${JSON.stringify(args)}).catch(()=>process.exit(2))`,
          ],
          { stdio: 'ignore' },
        );
      } catch (error) {
        // Exit 2 is a rejected finder; startup/API and process failures are fatal.
        if (error.status === 2 && !error.signal) return prerequisite;
        throw error;
      }
    }
    return null;
  }
  if (!['linux', 'darwin'].includes(process.platform))
    return `a supported native vault host (not ${process.platform})`;
  const header = resolve(
    dirname(process.execPath),
    '..',
    'include/node/node_version.h',
  );
  if (!existsSync(header))
    return `Node ${process.versions.node} headers beside ${process.execPath}`;
  const text = readFileSync(header, 'utf8');
  const version = ['MAJOR', 'MINOR', 'PATCH']
    .map(
      (part) =>
        text.match(new RegExp(`#define NODE_${part}_VERSION (\\d+)`))?.[1],
    )
    .join('.');
  if (version !== process.versions.node)
    return `matching Node ${process.versions.node} headers (found ${version})`;
  const probes =
    process.platform === 'linux'
      ? [
          ['/usr/bin/cc', ['--version'], 'C compiler (/usr/bin/cc)'],
          [
            '/usr/bin/pkg-config',
            ['--atleast-version=0.21.4', 'libsecret-1'],
            'libsecret-1 >=0.21.4 (pkg-config and libsecret-1-dev)',
          ],
        ]
      : [
          [
            '/usr/bin/xcrun',
            ['--find', 'clang'],
            'Xcode Command Line Tools (clang)',
          ],
          [
            '/usr/bin/xcrun',
            ['--show-sdk-path'],
            'macOS SDK (Xcode Command Line Tools)',
          ],
        ];
  for (const [command, args, prerequisite] of probes) {
    try {
      execFileSync(command, args, {
        stdio: 'ignore',
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          ...(process.env.DEVELOPER_DIR
            ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR }
            : {}),
        },
      });
    } catch (error) {
      if (
        error.code === 'ENOENT' ||
        (Number.isInteger(error.status) && error.status > 0 && !error.signal)
      )
        return prerequisite;
      throw error;
    }
  }
  return null;
}
