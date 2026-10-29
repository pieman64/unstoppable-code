export interface CommandSpec {
  command: string;
  args: string[];
}

export function isWindowsCommandShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

export function quoteCmdArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      'Cannot pass command arguments containing newlines through cmd.exe',
    );
  }

  if (value.includes('%')) {
    throw new Error(
      'Cannot pass command arguments containing % through cmd.exe because environment variables would be expanded',
    );
  }

  if (!/[ \t&|<>^()"]/.test(value)) {
    return value;
  }

  return `"${value.split('"').join('""')}"`;
}

export function buildCmdCommandLine(
  command: string,
  args: string[] = [],
): string {
  return [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(' ');
}

export function wrapWindowsCommandShim(
  spec: CommandSpec,
  platform: NodeJS.Platform = process.platform,
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
