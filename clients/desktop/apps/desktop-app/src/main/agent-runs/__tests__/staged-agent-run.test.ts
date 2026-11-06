import { currentAgentWorkerContext } from '../agent-worker-context';
import { AgentRunClosedError, StagedAgentRun } from '../staged-agent-run';

const context = { kind: 'turn' as const, runId: 'run' };

it('execute waits for take and then runs inside the worker context', async () => {
  const run = new StagedAgentRun(context);
  const seen: unknown[] = [];
  let ran = false;
  const executing = run.execute(async () => {
    ran = true;
    seen.push(currentAgentWorkerContext());
    await Promise.resolve();
    seen.push(currentAgentWorkerContext());
    return 'done';
  });
  await Promise.resolve();
  expect(ran).toBe(false);
  run.take();
  expect(await executing).toBe('done');
  expect(seen).toEqual([context, context]);
  expect(currentAgentWorkerContext()).toBeUndefined();
});

it('executeSync throws before take and after close', () => {
  const run = new StagedAgentRun(context);
  expect(() => run.executeSync(() => 1)).toThrow(AgentRunClosedError);
  run.take();
  expect(run.executeSync(() => currentAgentWorkerContext())).toEqual(context);
  run.close();
  expect(() => run.executeSync(() => 1)).toThrow(AgentRunClosedError);
});

it('close rejects a waiting execute', async () => {
  const run = new StagedAgentRun(context);
  const fn = jest.fn();
  const executing = run.execute(fn);
  const error = new Error('stopped');
  run.close(error);
  await expect(executing).rejects.toBe(error);
  expect(fn).not.toHaveBeenCalled();
});
