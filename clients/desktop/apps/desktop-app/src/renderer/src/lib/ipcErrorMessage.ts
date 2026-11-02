import { extractIpcErrorMessage } from './errors';

/** The shared sections show thrown messages verbatim; drop Electron's IPC wrapper. */
export async function withIpcErrorMessage<T>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(extractIpcErrorMessage(error));
  }
}
