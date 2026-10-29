// Fixed Node-only owned descendant: the supervisor must escalate beyond TERM.
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
assert(process.argv.length === 3 && path.isAbsolute(file));
process.on('SIGTERM', () => {});
const temporary = `${file}.${process.pid}.tmp`;
writeFileSync(temporary, `${process.pid}\n`, { flag: 'wx' });
renameSync(temporary, file);
setInterval(() => {}, 1000);
