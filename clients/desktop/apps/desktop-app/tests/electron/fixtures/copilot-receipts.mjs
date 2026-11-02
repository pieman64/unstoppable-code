import fs from 'node:fs';
import path from 'node:path';

export function readCopilotReceipts(userDataDir) {
  const directory = path.join(userDataDir, 'copilot-runtime-receipts');
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        const receipt = JSON.parse(
          fs.readFileSync(path.join(directory, name), 'utf8'),
        );
        return [{ name, processes: receipt.processes }];
      } catch (error) {
        // Runtime close may remove a receipt between enumeration and reading.
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    });
}

export function priorCopilotReceipts(previous, current) {
  const names = new Set(previous.map((receipt) => receipt.name));
  const identities = new Set(
    previous.flatMap((receipt) =>
      receipt.processes.map((row) => `${row.pid}:${row.started}`),
    ),
  );
  return current.filter(
    (receipt) =>
      names.has(receipt.name) ||
      receipt.processes.some((row) =>
        identities.has(`${row.pid}:${row.started}`),
      ),
  );
}

export function copilotProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function copilotReceiptEvidence(receipts) {
  return receipts.map((receipt) => ({
    ...receipt,
    livePids: receipt.processes
      .filter((row) => copilotProcessAlive(row.pid))
      .map((row) => row.pid),
  }));
}
