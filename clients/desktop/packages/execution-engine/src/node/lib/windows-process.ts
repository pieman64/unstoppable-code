import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  buildCmdCommandLine,
  quoteCmdArgument,
} from '@canopy/core-platform/windows-shells';

export interface CommandSpec {
  command: string;
  args: string[];
}

export function isWindowsCommandShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

export { buildCmdCommandLine, quoteCmdArgument };

export function wrapWindowsCommandShim(
  spec: CommandSpec,
  platform: NodeJS.Platform | null = hostOperatingSystem(),
  comSpec: string | undefined = process.env.ComSpec,
): CommandSpec {
  if (platform !== 'win32' || !isWindowsCommandShim(spec.command)) {
    return spec;
  }

  return {
    command: comSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', buildCmdCommandLine(spec.command, spec.args)],
  };
}
