import { readFileSync } from 'node:fs';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';

type NotificationChannel = 'desktop';

function parseChannel(raw: string | undefined): NotificationChannel {
  const channel = raw?.trim();
  if (!channel || channel === 'desktop') {
    return 'desktop';
  }
  throw new Error('notify requires channel "desktop"');
}

function readBody(env: NodeJS.ProcessEnv): string {
  const bodyFile = env.INPUT_BODY_FILE?.trim();
  if (bodyFile) {
    return readFileSync(bodyFile, 'utf8');
  }
  return env.INPUT_BODY ?? '';
}

function requireInput(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`notify requires input "${name}"`);
  }
  return trimmed;
}

function sendDesktop(env: NodeJS.ProcessEnv): void {
  const title = requireInput(env.INPUT_TITLE, 'title');
  const body = readBody(env);
  setOutput(brandEnvName('NOTIFICATION'), JSON.stringify({ title, body }));
  setOutput('sent', 'true');
}

export function runNotifyAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return runWithActionEnvironment(env, () => {
    parseChannel(env.INPUT_CHANNEL);
    sendDesktop(env);
  });
}
