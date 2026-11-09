import Module from 'node:module';
import * as path from 'node:path';

// Jest maps `electron` to electronMock.ts. A plain Node child that loads main
// modules does the same, so it never loads, or downloads, the real Electron.
// Import this before any module that reaches `electron`.
const ELECTRON_MOCK = path.resolve(
  __dirname,
  '../../../../__tests__/electronMock.ts',
);

const resolveFilename: unknown = Reflect.get(Module, '_resolveFilename');
if (typeof resolveFilename !== 'function')
  throw new Error('Node has no module resolver to redirect Electron.');
Reflect.set(
  Module,
  '_resolveFilename',
  function (this: unknown, request: unknown, ...rest: unknown[]): unknown {
    const resolved: unknown = Reflect.apply(resolveFilename, this, [
      request === 'electron' ? ELECTRON_MOCK : request,
      ...rest,
    ]);
    return resolved;
  },
);
