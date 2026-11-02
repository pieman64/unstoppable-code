import { coalesceTranscriptResetReload } from '../transcript-reset';

it('coalesces concurrent transcript reset reload callers and releases the slot after completion', async () => {
  let finish: (() => void) | undefined;
  const reload = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );

  const first = coalesceTranscriptResetReload('project/worktree/chat', reload);
  const second = coalesceTranscriptResetReload('project/worktree/chat', reload);
  expect(second).toBe(first);
  await Promise.resolve();

  expect(reload).toHaveBeenCalledTimes(1);
  finish?.();
  await Promise.all([first, second]);

  const afterCompletion = coalesceTranscriptResetReload(
    'project/worktree/chat',
    reload,
  );
  expect(reload).toHaveBeenCalledTimes(2);
  finish?.();
  await afterCompletion;
});
