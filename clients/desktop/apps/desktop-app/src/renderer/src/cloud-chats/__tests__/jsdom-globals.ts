// jsdom lacks the TextEncoder and structuredClone the protocol package and the
// shared editor use at import time; the test imports this module first.
// eslint-disable-next-line no-restricted-imports
import { TextEncoder } from 'node:util';

globalThis.TextEncoder ??= TextEncoder;
globalThis.structuredClone ??= <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;
