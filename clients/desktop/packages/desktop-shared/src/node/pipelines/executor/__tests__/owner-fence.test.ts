import type { ExecutionState } from '../../../../types/pipeline';
import {
  claimPipelineOwner,
  configurePipelineOwnerFence,
  isKnownOrphanedExecution,
  pipelineOwnerFields,
  type PipelineOwnerInspection,
} from '../owner-fence';

const OTHER_PID = 52_525;

function owned(
  fields: Pick<ExecutionState, 'owner_pid' | 'owner_start_identity'>,
): Pick<ExecutionState, 'owner_pid' | 'owner_start_identity'> {
  return { ...fields };
}

function host(
  identities: Map<number, PipelineOwnerInspection>,
): (pid: number) => Promise<PipelineOwnerInspection> {
  return (pid: number): Promise<PipelineOwnerInspection> =>
    Promise.resolve(identities.get(pid) ?? { state: 'absent' });
}

describe('pipeline owner fence', () => {
  let kill: jest.SpyInstance;

  beforeEach(() => {
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(async () => {
    kill.mockRestore();
    await configurePipelineOwnerFence(null);
  });

  it('records the owner start identity when the host proves it', async () => {
    await configurePipelineOwnerFence(
      host(
        new Map([
          [process.pid, { state: 'running', startIdentity: 'darwin:v1:me' }],
        ]),
      ),
    );
    expect(pipelineOwnerFields()).toEqual({
      owner_pid: process.pid,
      owner_start_identity: 'darwin:v1:me',
    });
    await configurePipelineOwnerFence(null);
    const state = owned({ owner_pid: 1, owner_start_identity: 'old' });
    claimPipelineOwner(state);
    expect(state).toEqual({ owner_pid: process.pid });
  });

  it('treats a live PID with another start identity as orphaned', async () => {
    await configurePipelineOwnerFence(
      host(
        new Map([
          [OTHER_PID, { state: 'running', startIdentity: 'darwin:v1:reused' }],
        ]),
      ),
    );
    await expect(
      isKnownOrphanedExecution(
        owned({ owner_pid: OTHER_PID, owner_start_identity: 'darwin:v1:old' }),
      ),
    ).resolves.toBe(true);
    await expect(
      isKnownOrphanedExecution(
        owned({
          owner_pid: OTHER_PID,
          owner_start_identity: 'darwin:v1:reused',
        }),
      ),
    ).resolves.toBe(false);
  });

  it('keeps PID liveness alone without a recorded or provable identity', async () => {
    await configurePipelineOwnerFence(
      host(new Map([[OTHER_PID, { state: 'unverifiable' }]])),
    );
    await expect(
      isKnownOrphanedExecution(owned({ owner_pid: OTHER_PID })),
    ).resolves.toBe(false);
    await expect(
      isKnownOrphanedExecution(
        owned({ owner_pid: OTHER_PID, owner_start_identity: 'darwin:v1:old' }),
      ),
    ).resolves.toBe(false);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await expect(
      isKnownOrphanedExecution(owned({ owner_pid: OTHER_PID })),
    ).resolves.toBe(true);
  });
});
