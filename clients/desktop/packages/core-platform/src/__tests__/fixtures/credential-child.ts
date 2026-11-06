// Test-only: operates exclusively on the unique synthetic targets supplied by the golden.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid fixture input.');
  return value;
}
const addon: unknown = createRequire(import.meta.url)(string(process.argv[2]));
const request: unknown = JSON.parse(
  readFileSync(string(process.argv[3]), 'utf8'),
);
const sid = string(process.argv[4] || field(request, 'principal'));
const target = string(field(request, 'target'));
const mode = string(field(request, 'mode'));
const mutex = `Global\\canopy.vault.v1.${createHash('sha256')
  .update(JSON.stringify([sid, target]))
  .digest('hex')}`;
const signal = new Uint32Array(new SharedArrayBuffer(4));
function method(name: string, ...args: unknown[]): unknown {
  const fn = field(addon, name);
  if (typeof fn !== 'function') throw new Error('Invalid fixture addon.');
  return Reflect.apply(fn, addon, args);
}
interface Reply {
  code: string;
  material?: number[];
}
async function run(
  op: string,
  name = target,
  material = new Uint8Array(),
): Promise<Reply> {
  const raw: unknown = await Promise.resolve(
    method('run', op, name, mutex, material, sid, signal),
  );
  const code = string(field(raw, 'code'));
  const bytes = field(raw, 'material');
  if (!(bytes instanceof Uint8Array)) return { code };
  try {
    return { code, material: Array.from(bytes) };
  } finally {
    bytes.fill(0);
  }
}
async function waitForLine(): Promise<void> {
  const input = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => input.once('line', resolve));
  input.close();
}
async function main(): Promise<void> {
  if (mode === 'hold') {
    const held = method('holdMutex', mutex, sid, true);
    process.stdout.write('ready\n');
    await waitForLine();
    method('releaseMutex', held);
    return;
  }
  if (mode === 'race') {
    const bytes = field(request, 'bytes');
    if (
      !Array.isArray(bytes) ||
      !bytes.every((byte: unknown) => typeof byte === 'number')
    )
      throw new Error('Invalid fixture material.');
    process.stdout.write('ready\n');
    await waitForLine();
    const operation = field(request, 'operation') ?? 'create';
    if (
      operation !== 'create' &&
      operation !== 'replace' &&
      operation !== 'delete'
    )
      throw new Error('Invalid fixture operation.');
    const result = await run(operation, target, Uint8Array.from(bytes));
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  // B needs a working credential set, not merely a failed read.
  const control = target + '-control';
  const receipt: Record<string, Reply | boolean | string> = {
    challenge: string(field(request, 'challenge')),
  };
  try {
    receipt.status = await run('status');
    receipt.controlCreate = await run('create', control, new Uint8Array([22]));
    receipt.controlRead = await run('read', control);
    receipt.probe = await run('read');
    receipt.sameCreate = await run('create', target, new Uint8Array([23]));
    receipt.sameRead = await run('read');
  } finally {
    // Also clean B's synthetic credentials when a later assertion/setup fails.
    receipt.sameDelete = await run('delete');
    receipt.controlDelete = await run('delete', control);
  }
  const vaultFile = field(request, 'vaultFile');
  if (typeof vaultFile === 'string') {
    try {
      readFileSync(vaultFile);
      receipt.directoryDenied = false;
    } catch (error) {
      const code = field(error, 'code');
      receipt.directoryDenied = code === 'EACCES' || code === 'EPERM';
    }
  }
  // Synthetic bytes only: no session/user/profile facts in the receipt.
  writeFileSync(string(field(request, 'output')), JSON.stringify(receipt));
}
main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    const code = field(error, 'code');
    process.stderr.write(
      `credential-child-failed:${typeof code === 'string' ? code.slice(0, 40) : 'operation'}\n`,
    );
    process.exitCode = 1;
  },
);
