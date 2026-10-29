import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { parseModelPackageConfig } from '../packages/desktop-shared/src/model-config';

const packageJsonPath = resolve(process.cwd(), 'package.json');

try {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const config = parseModelPackageConfig(pkg);
  process.stdout.write(
    `Model configuration valid: ${config.claudeModels.length} Claude-harness, ` +
      `${config.codexModels.length} Codex-harness, ` +
      'No API-owned models are embedded in package configuration.\n',
  );
} catch (error) {
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      process.stderr.write(`${location}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exitCode = 1;
}
