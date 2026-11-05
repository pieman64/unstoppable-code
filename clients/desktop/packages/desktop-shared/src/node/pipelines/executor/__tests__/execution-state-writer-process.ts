import { readFile } from 'node:fs/promises';
import {
  loadExecutionState,
  saveExecutionState,
  setExecutionHidden,
  isExecutionStateWriteRefusal,
} from '../execution-state';

async function waitUntil(time: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, time - Date.now())),
  );
}

async function main(): Promise<void> {
  const [role, dir, fixturePath, countText, startText, releaseText] =
    process.argv.slice(2);
  await waitUntil(Number(startText));
  const parsed: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string'
  ) {
    throw new Error('Expected an execution fixture');
  }
  const state = await loadExecutionState(parsed.id, dir);
  if (!state) throw new Error('Expected the installed execution fixture');
  Object.assign(state, parsed);
  state.status = 'running';
  state.owner_pid = process.pid;
  delete state.owner_start_identity;
  if (role === 'resumer') {
    try {
      await saveExecutionState(state, dir);
      process.stdout.write('admitted\n');
    } catch (error) {
      if (!isExecutionStateWriteRefusal(error)) throw error;
      process.stdout.write(`refused:${error.reason}\n`);
    }
    await waitUntil(Number(releaseText));
    return;
  }
  const results: {
    saveSucceeded: number;
    hideSucceeded: number;
    refusals: Record<string, number>;
  } = {
    saveSucceeded: 0,
    hideSucceeded: 0,
    refusals: {},
  };
  for (let index = 0; index < Number(countText); index += 1) {
    state.env = {
      ...state.env,
      TEST_SEQUENCE: role === 'owner' ? String(index) : 'intruder',
    };
    if (role === 'owner') {
      await saveExecutionState(structuredClone(state), dir);
      continue;
    }
    for (const kind of ['save', 'hide']) {
      try {
        if (kind === 'save') {
          await saveExecutionState(structuredClone(state), dir);
          results.saveSucceeded += 1;
        } else {
          await setExecutionHidden(state.id, true, dir);
          results.hideSucceeded += 1;
        }
      } catch (error) {
        if (!isExecutionStateWriteRefusal(error)) throw error;
        results.refusals[error.reason] =
          (results.refusals[error.reason] ?? 0) + 1;
      }
    }
  }
  if (role === 'owner') {
    process.stdout.write('writes-complete\n');
    await new Promise<void>((resolve) => {
      process.stdin.once('end', resolve);
      process.stdin.resume();
    });
  } else {
    process.stdout.write(`${JSON.stringify(results)}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
