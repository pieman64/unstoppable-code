import { appendFileSync } from 'fs';

const message: string = process.env.INPUT_MESSAGE || '';
const outputFile: string = process.env['{{BRAND_ENV_PREFIX}}_OUTPUT'] || '';

const timestamp: string = new Date().toISOString();
const tag: string = `${timestamp}-tsx`;

console.log(`Hello, World! ${message}`.trim());
console.log(`Timestamp tag: ${tag}`);

if (outputFile) {
  appendFileSync(outputFile, `timestamp=${tag}\n`);
}
