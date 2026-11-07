import type { BrowserWindow } from 'electron';
import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import {
  mainWindowOnlyToolSurfaces,
  requestShowFilesThroughLease,
} from '../canopy-tools/show-files-runtime';
import { createShowVisualHost } from '../canopy-tools/show-visual-host';
import type { ShowVisualHost } from '../canopy-tools/show-visual-runtime';

export type InterfaceAnswerRequest = Omit<
  Parameters<typeof requestAnswersFromRenderer>[0],
  'getWindow'
>;
export type InterfaceShowFilesRequest = Parameters<
  typeof requestShowFilesThroughLease
>[0];

/**
 * Presentation requests an agent tool makes of the chat's interface
 * (CAN-4125). ShowFiles reaches the main window through its interface lease
 * (CAN-4131); the other requests still drive the main window.
 */
export interface InterfaceToolRequests {
  requestUserAnswers(
    request: InterfaceAnswerRequest,
  ): Promise<McpQuestionAnswer[]>;
  showFiles(
    request: InterfaceShowFilesRequest,
    options?: { signal?: AbortSignal },
  ): ReturnType<typeof requestShowFilesThroughLease>;
  showVisualHost(
    target: Parameters<typeof createShowVisualHost>[0],
  ): ShowVisualHost;
  /** The window two legacy runtimes still take: file comment broadcasts and worktree actions. CAN-4131 removes it. */
  legacyWindow(): BrowserWindow | null;
}

export function createWindowInterfaceToolRequests(
  getWindow: () => BrowserWindow | null,
): InterfaceToolRequests {
  return {
    requestUserAnswers: (request) =>
      requestAnswersFromRenderer({ ...request, getWindow }),
    showFiles: (request, options) =>
      requestShowFilesThroughLease(
        request,
        mainWindowOnlyToolSurfaces(getWindow),
        options,
      ),
    showVisualHost: createShowVisualHost,
    legacyWindow: getWindow,
  };
}
