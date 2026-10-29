import { execFile } from 'node:child_process';

export interface WindowsDefaultBrowserCapabilities {
  appId: string;
  appName: string;
  description: string;
  executablePath: string;
}

type RunRegCommand = (args: string[]) => Promise<void>;

function runRegCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (error) => {
      if (error) {
        reject(new Error(error.message));
      } else resolve();
    });
  });
}

/**
 * Advertise the running executable in the current user's Windows Default Apps
 * catalog. This deliberately does not claim HTTP(S); Windows keeps that choice
 * behind its Settings UI. Running it again is idempotent and also covers the
 * published ZIP build, which never executes the NSIS registration macros.
 */
export async function advertiseWindowsDefaultBrowserCapabilities(
  capabilities: WindowsDefaultBrowserCapabilities,
  run: RunRegCommand = runRegCommand,
): Promise<void> {
  const classesKey = `HKCU\\Software\\Classes\\${capabilities.appId}.URL`;
  const clientKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${capabilities.appId}`;
  const capabilitiesKey = `${clientKey}\\Capabilities`;
  const command = `"${capabilities.executablePath}" "%1"`;
  const icon = `${capabilities.executablePath},0`;

  const writes: string[][] = [
    ['ADD', classesKey, '/ve', '/d', `${capabilities.appName} URL`, '/f'],
    ['ADD', classesKey, '/v', 'URL Protocol', '/d', '', '/f'],
    ['ADD', `${classesKey}\\DefaultIcon`, '/ve', '/d', icon, '/f'],
    ['ADD', `${classesKey}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
    ['ADD', clientKey, '/ve', '/d', capabilities.appName, '/f'],
    ['ADD', `${clientKey}\\DefaultIcon`, '/ve', '/d', icon, '/f'],
    ['ADD', `${clientKey}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
    [
      'ADD',
      capabilitiesKey,
      '/v',
      'ApplicationDescription',
      '/d',
      capabilities.description,
      '/f',
    ],
    ['ADD', capabilitiesKey, '/v', 'ApplicationIcon', '/d', icon, '/f'],
    [
      'ADD',
      capabilitiesKey,
      '/v',
      'ApplicationName',
      '/d',
      capabilities.appName,
      '/f',
    ],
    [
      'ADD',
      `${capabilitiesKey}\\URLAssociations`,
      '/v',
      'http',
      '/d',
      `${capabilities.appId}.URL`,
      '/f',
    ],
    [
      'ADD',
      `${capabilitiesKey}\\URLAssociations`,
      '/v',
      'https',
      '/d',
      `${capabilities.appId}.URL`,
      '/f',
    ],
    [
      'ADD',
      'HKCU\\Software\\RegisteredApplications',
      '/v',
      capabilities.appId,
      '/d',
      `Software\\Clients\\StartMenuInternet\\${capabilities.appId}\\Capabilities`,
      '/f',
    ],
  ];

  for (const args of writes) await run(args);
}
