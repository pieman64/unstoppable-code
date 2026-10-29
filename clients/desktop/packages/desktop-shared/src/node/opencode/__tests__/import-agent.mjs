import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [command, file] = process.argv.slice(2);
if (command !== 'import' || !path.isAbsolute(file)) process.exit(5);
if (process.env.OPENCODE_IMPORT_FIXTURE === 'flood') {
  process.stdout.write('SECRET'.repeat(100_000));
  setInterval(() => {}, 1000);
} else if (process.env.OPENCODE_IMPORT_FIXTURE === 'hang') {
  await writeFile(process.env.OPENCODE_IMPORT_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(
    process.env.OPENCODE_DB,
    JSON.stringify({
      command,
      snapshot,
      config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
      auth: process.env.OPENCODE_AUTH_CONTENT,
      configDir: process.env.OPENCODE_CONFIG_DIR,
      dataDir: process.env.XDG_DATA_HOME,
      cwd: process.cwd(),
    }),
  );
  process.stdout.write('Imported session\n');
}
