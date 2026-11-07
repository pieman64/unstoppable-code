import {
  WORKER_AGENT_SIGN_IN_FAILED_CODE,
  WORKER_AGENT_SIGN_IN_FAILED_MESSAGE,
  providerCredentialEffects,
  type WorkerAgentSignInRunParams,
  type WorkerAgentSignInRunResult,
} from '@canopy/protocol/canopy-core';
import {
  signInLaunchUnavailableError,
  type SignInExecutionWorker,
} from '@canopy/core-runtime/node/agent/sign-in';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { runInSignInWorker } from './sign-in-worker-context';

export interface SignInLaunchOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: string | null;
}
export type SignInLaunch = (
  signal: AbortSignal,
) => Promise<SignInLaunchOutcome>;

interface StagedLaunch {
  launch: SignInLaunch;
  redeemed(): void;
}
const stagedLaunches = new Map<string, StagedLaunch>();

export function stageSignInLaunch(
  signInRunId: string,
  launch: SignInLaunch,
): { take(): { ran: boolean } } {
  let ran = false;
  stagedLaunches.set(signInRunId, {
    launch,
    redeemed: () => {
      ran = true;
    },
  });
  return {
    take: (): { ran: boolean } => {
      stagedLaunches.delete(signInRunId);
      return { ran };
    },
  };
}

function result(
  params: WorkerAgentSignInRunParams,
  credentialEffects: WorkerAgentSignInRunResult['credentialEffects'],
  outcome: SignInLaunchOutcome,
): WorkerAgentSignInRunResult {
  const base = {
    signInRunId: params.signInRunId,
    provider: params.provider,
    credentialEffects,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  };
  if (outcome.status === 'failed')
    return {
      ...base,
      status: 'failed',
      error: {
        code: WORKER_AGENT_SIGN_IN_FAILED_CODE,
        message: WORKER_AGENT_SIGN_IN_FAILED_MESSAGE,
      },
    };
  return { ...base, status: outcome.status };
}

export const desktopSignInWorker: SignInExecutionWorker = {
  run: async (params, signal): Promise<WorkerAgentSignInRunResult> => {
    const staged = stagedLaunches.get(params.signInRunId);
    if (!staged) throw signInLaunchUnavailableError();
    stagedLaunches.delete(params.signInRunId);
    const os = hostOperatingSystem();
    const notLaunched = { exitCode: null, signal: null };
    if (os === null)
      return result(params, [], { status: 'failed', ...notLaunched });
    const effects = providerCredentialEffects(params.provider, os);
    if (signal.aborted)
      return result(params, effects, { status: 'cancelled', ...notLaunched });
    staged.redeemed();
    let outcome: SignInLaunchOutcome;
    try {
      outcome = await runInSignInWorker(
        { signInRunId: params.signInRunId, provider: params.provider },
        () => staged.launch(signal),
      );
    } catch {
      outcome = { status: 'failed', ...notLaunched };
    }
    if (signal.aborted) outcome = { ...outcome, status: 'cancelled' };
    return result(params, effects, outcome);
  },
};
