// Reads which process listens on a loopback port from the tools each OS
// ships, so the proxy on this device is only trusted on a port it holds.

/** Inodes of the sockets listening on `port`, from a /proc/net/tcp table. */
export function listeningInodes(table: string, port: number): Set<string> {
  const inodes = new Set<string>();
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1]?.split(':');
    // State 0A is LISTEN.
    if (
      fields[3] === '0A' &&
      local &&
      Number.parseInt(local[1] ?? '', 16) === port
    ) {
      if (fields[9]) inodes.add(fields[9]);
    }
  }
  return inodes;
}

/**
 * Whether `netstat -ano -p TCP` output shows `pid` listening on `port`.
 * Windows translates the state column, so a listener is told apart by its
 * unset foreign address instead of the word LISTENING.
 */
export function netstatShowsListener(
  output: string,
  pid: number,
  port: number,
): boolean {
  return output.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields[0] === 'TCP' &&
      fields[1]?.endsWith(`:${String(port)}`) === true &&
      (fields[2] === '0.0.0.0:0' || fields[2] === '[::]:0') &&
      fields[fields.length - 1] === String(pid)
    );
  });
}
