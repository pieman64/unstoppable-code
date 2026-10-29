import { verifyManagedExecutable } from '../managed-runtime/verification';

export function verifyCopilotExecutable(
  file: string,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<void> {
  return verifyManagedExecutable(file, expectedSha256, signal, 'Copilot');
}
