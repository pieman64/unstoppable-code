// jsdom omits the WHATWG encoding globals that the OOXML fixtures and the
// presentation parser create at module load. Import this before them.
import { TextDecoder, TextEncoder } from 'node:util';

Object.assign(globalThis, { TextDecoder, TextEncoder });
