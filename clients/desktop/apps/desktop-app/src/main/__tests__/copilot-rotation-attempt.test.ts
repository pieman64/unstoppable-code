import { readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getCopilotRotationAttemptPath } from '../lib/paths';
import {
  writeCopilotRotationAttempt,
  removeCopilotRotationAttempt,
  probeCopilotRotationAttempt,
} from '../copilot/rotation-attempt';

const attempt = {
  attemptId: 'first',
  bootId: 'boot',
  accountEpoch: { host: 'https://github.com', id: '1', entryId: 'entry' },
  fromDigest: createHash('sha256').update('ghr_secret-refresh').digest('hex'),
};
afterEach(async () => {
  await rm(getCopilotRotationAttemptPath(), { force: true });
});

test('records only diagnostic identity and digest; scan for grant substrings', async () => {
  await writeCopilotRotationAttempt(attempt);
  const bytes = await readFile(getCopilotRotationAttemptPath(), 'utf8');
  expect(JSON.parse(bytes)).toEqual({ version: 1, ...attempt });
  for (const secret of [
    'ghr_',
    'ghu_',
    'secret-refresh',
    'accessToken',
    'refreshToken',
  ])
    expect(bytes).not.toContain(secret);
  expect(await probeCopilotRotationAttempt()).toBe('present');
  await removeCopilotRotationAttempt(attempt.attemptId);
  expect(await probeCopilotRotationAttempt()).toBe('absent');
});

test('old completion cannot remove a newer epoch record', async () => {
  await writeCopilotRotationAttempt(attempt);
  await writeCopilotRotationAttempt({
    ...attempt,
    attemptId: 'next',
    accountEpoch: { ...attempt.accountEpoch, entryId: 'new' },
  });
  await removeCopilotRotationAttempt('first');
  const record: unknown = JSON.parse(
    await readFile(getCopilotRotationAttemptPath(), 'utf8'),
  );
  expect(record).toHaveProperty('attemptId', 'next');
});

test.each(['not json', '{"version":2}', '{}'])(
  'preserves an unreadable diagnostic without acting on it (%s)',
  async (contents) => {
    await writeCopilotRotationAttempt(attempt);
    await writeFile(getCopilotRotationAttemptPath(), contents);
    expect(await probeCopilotRotationAttempt()).toBe('unreadable');
    expect(await readFile(getCopilotRotationAttemptPath(), 'utf8')).toBe(
      contents,
    );
  },
);

test('an absent diagnostic has no recovery work', async () => {
  await rm(getCopilotRotationAttemptPath(), { force: true });
  expect(await probeCopilotRotationAttempt()).toBe('absent');
});
