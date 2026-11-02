import { PipelineHostRefusal } from '@canopy/desktop-shared/pipelines/host-actions';
import { pipelineTrustedCaller } from '../pipeline-caller';

const base = {
  executionId: 'exec-1',
  jobId: 'job',
  stepId: 'create',
  attempt: 0,
  iteration: 0,
  idempotencyKey: 'pipeline-host:exec-1:job::create:0:0',
};

it('reads the run owner from execution_context', () => {
  expect(
    pipelineTrustedCaller({
      ...base,
      executionContext: 'org:5b1d7c1e-8d0b-4d39-9a52-2f7e0b5f9b11',
    }).owner,
  ).toEqual({
    kind: 'organization',
    organizationId: '5b1d7c1e-8d0b-4d39-9a52-2f7e0b5f9b11',
  });
});

it('treats a run without an owner as Personal, like the host owner check', () => {
  expect(pipelineTrustedCaller(base).owner).toEqual({ kind: 'personal' });
});

it('refuses an owner it cannot parse', () => {
  let thrown: unknown;
  try {
    pipelineTrustedCaller({ ...base, executionContext: 'garbage' });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PipelineHostRefusal);
  expect(thrown).toMatchObject({ failureReason: 'owner_context_unavailable' });
});

it('keeps the agent origin and drops absent optionals', () => {
  const agentOrigin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
  expect(pipelineTrustedCaller({ ...base, agentOrigin })).toEqual({
    executionId: 'exec-1',
    stepId: 'create',
    owner: { kind: 'personal' },
    agentOrigin,
  });
});
