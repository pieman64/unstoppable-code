import { withW5ProcessFileLocks } from '../../process-file-lock';
const [root = '', ...paths] = process.argv.slice(2);
process.stdout.write('started\n');
const timeoutMs = Number(process.env.W5_LOCK_TEST_TIMEOUT_MS ?? 5_000);
void withW5ProcessFileLocks(paths, { dataRoot: root, timeoutMs }, async () => {
  process.stdout.write('held\n');
  await new Promise<void>((resolve) =>
    process.stdin.once('data', () => resolve()),
  );
})
  .then(() => process.stdout.write('released\n'))
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
