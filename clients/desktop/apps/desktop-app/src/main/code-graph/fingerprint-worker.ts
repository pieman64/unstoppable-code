import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import { connectExecutionHostChannel } from '@canopy/desktop-shared/node/execution-host/channel';
import {
  executeCodeGraphFingerprint as executeHostCodeGraphFingerprint,
  serveCodeGraphFingerprintHost,
  type CodeGraphFingerprintWorkerRequest,
  type CodeGraphFingerprintWorkerResponse,
} from '@canopy/code-graph/host/fingerprint-host';

/** The fingerprint host's work, with the desktop's Git executable. */
export function executeCodeGraphFingerprint(
  request: CodeGraphFingerprintWorkerRequest,
): Promise<CodeGraphFingerprintWorkerResponse> {
  return executeHostCodeGraphFingerprint(request, {
    gitExecutable: getGitExecutableCommand(process.env),
  });
}

const channel = connectExecutionHostChannel();
if (channel)
  serveCodeGraphFingerprintHost(channel, {
    gitExecutable: getGitExecutableCommand(process.env),
  });
