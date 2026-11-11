// Read fd 0 directly: never initialize process.stdin's libuv handle and then
// close its descriptor behind libuv. IPC remains a separate barrier channel.
import { closeSync, read } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout, setImmediate } from 'node:timers';

const transport = process.argv[2];
const phase = process.argv[3];
function report(event: string, details: Record<string, unknown> = {}): void {
  if (!process.send) throw new Error('Missing fixture control channel');
  process.send({ event, ...details });
}
const watchdog = setTimeout(() => process.exit(91), 8000);
let buffer = '';
let state = 'protocol';
let bytesRead = 0;
function closeInput(): void {
  closeSync(0);
  state = 'closed';
  report('input-closed', { bytesRead });
}
// Tests release a retired worker after observing production's SIGTERM, proving
// replacement initialization waits for the actual native termination barrier.
process.on('SIGTERM', () => report('sigterm'));
process.on('disconnect', () => process.exit(92));
process.on('message', (message: unknown): void => {
  if (message === 'release') {
    // A healthy replacement still has one blocking fs.read outstanding. Its
    // parent ends stdin to unblock that read before Node joins the worker.
    if (phase === 'replacement') return;
    clearTimeout(watchdog);
    process.exit(0);
  } else if (message === 'close-before') {
    closeInput();
  } else if (message === 'close-during') {
    state = 'truncate';
    readNext();
    report('armed');
  } else if (message === 'fence') {
    report('fence');
  }
});
function readNext(): void {
  const chunk = Buffer.alloc(transport === 'mcp' ? 1 : 65536);
  read(0, chunk, 0, chunk.length, null, (error, count): void => {
    if (error?.code === 'EAGAIN') {
      setImmediate(readNext);
      return;
    }
    if (error) process.exit(93);
    if (count === 0) process.exit(phase === 'replacement' ? 0 : 93);
    if (transport === 'mcp' || state === 'truncate') {
      bytesRead += count;
      closeInput();
      return;
    }
    buffer += chunk.toString('utf8', 0, count);
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame: unknown = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (typeof frame !== 'object' || frame === null || !('method' in frame)) {
        throw new Error('Invalid production frame');
      }
      const method = frame.method;
      const id: unknown = 'id' in frame ? frame.id : undefined;
      if (
        typeof method !== 'string' ||
        (id !== undefined && typeof id !== 'string' && typeof id !== 'number')
      ) {
        throw new Error('Invalid production method or request ID');
      }
      report('frame', { method, id });
      if (method === 'initialize') {
        process.stdout.write(
          JSON.stringify({
            id,
            result: { userAgent: 'native-pipe-fixture' },
          }) + '\n',
        );
      } else if (method === 'account/read' && phase !== 'replacement') {
        state = 'held';
        report('pending-held');
      } else if (id !== undefined) {
        process.stdout.write(
          JSON.stringify({ id, result: { fixture: true } }) + '\n',
        );
      }
    }
    if (state === 'protocol') readNext();
  });
}
if (transport === 'mcp') {
  if (phase === 'before') {
    closeInput();
  } else {
    report('ready');
    readNext();
  }
} else {
  readNext();
  report('ready');
}
