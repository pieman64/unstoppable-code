const fs = require('fs');

const message = process.env.INPUT_MESSAGE || '';
const outputFile = process.env['{{BRAND_ENV_PREFIX}}_OUTPUT'] || '';

const timestamp = new Date().toISOString();
const tag = `${timestamp}-js`;

console.log(`Hello, World! ${message}`.trim());
console.log(`Timestamp tag: ${tag}`);

if (outputFile) {
  fs.appendFileSync(outputFile, `timestamp=${tag}\n`);
}
