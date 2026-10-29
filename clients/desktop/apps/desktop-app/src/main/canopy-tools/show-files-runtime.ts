import { browserHandoffs } from '../browser/browser-handoffs';
import {
  capturePresentationTurn,
  showFilesPresentationPolicy,
} from './presentation-state';
import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type {
  AppAdvisorRendererToolRequest,
  ShowFilesChatOrigin,
  ShowFileRequest,
  ShowFilesRendererResult,
  ShowFilesWorkspaceTarget,
} from '@canopy/desktop-shared/types';
import { requestAppAdvisorRendererTool } from '../ipc/app-advisor';
import type { AppAdvisorRendererToolSurfaces } from '../ipc/app-advisor';

function normalizeFiles(
  files: ShowFileRequest[],
  cwd?: string,
): ShowFileRequest[] {
  return files.map((file) => ({
    ...file,
    path:
      !isAbsolute(file.path) && cwd
        ? resolve(cwd, file.path)
        : normalize(file.path),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const candidate = value[key];
  return candidate === undefined
    ? undefined
    : typeof candidate === 'string'
      ? candidate
      : null;
}

function fileResultFrom(
  value: unknown,
): ShowFilesRendererResult['files'][number] | null {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.ok !== 'boolean'
  ) {
    return null;
  }
  const absolutePath = optionalString(value, 'absolutePath');
  const tabId = optionalString(value, 'tabId');
  const browserId = optionalString(value, 'browserId');
  const warning = optionalString(value, 'warning');
  const error = optionalString(value, 'error');
  if (
    absolutePath === null ||
    tabId === null ||
    browserId === null ||
    warning === null ||
    error === null ||
    (value.openedIn !== undefined && value.openedIn !== 'browser') ||
    ['opened', 'activated', 'deferred'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
    )
  ) {
    return null;
  }
  return {
    ...(typeof value.opened === 'boolean' ? { opened: value.opened } : {}),
    ...(typeof value.activated === 'boolean'
      ? { activated: value.activated }
      : {}),
    ...(typeof value.deferred === 'boolean'
      ? { deferred: value.deferred }
      : {}),
    path: value.path,
    ok: value.ok,
    ...(absolutePath !== undefined ? { absolutePath } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
    ...(browserId !== undefined ? { browserId } : {}),
    ...(value.openedIn === 'browser' ? { openedIn: 'browser' as const } : {}),
    ...(warning !== undefined ? { warning } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function resultFrom(value: unknown): ShowFilesRendererResult {
  if (
    !isRecord(value) ||
    typeof value.opened !== 'number' ||
    typeof value.failed !== 'number' ||
    !Number.isSafeInteger(value.opened) ||
    value.opened < 0 ||
    !Number.isSafeInteger(value.failed) ||
    value.failed < 0 ||
    (value.activated !== undefined && typeof value.activated !== 'boolean') ||
    (value.deferred !== undefined &&
      (typeof value.deferred !== 'number' ||
        !Number.isSafeInteger(value.deferred) ||
        value.deferred < 0)) ||
    (value.presentation !== undefined &&
      (typeof value.presentation !== 'string' ||
        !['foreground', 'background', 'deferred'].includes(
          value.presentation,
        ))) ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' ||
        !['automation_turn', 'browser_handoff', 'unknown_turn'].includes(
          value.reason,
        ))) ||
    !Array.isArray(value.files)
  ) {
    throw new Error('The renderer returned an invalid ShowFiles response.');
  }
  const files = value.files.map(fileResultFrom);
  if (files.some((file) => file === null)) {
    throw new Error('The renderer returned an invalid ShowFiles response.');
  }
  return {
    ...(typeof value.activated === 'boolean'
      ? { activated: value.activated }
      : {}),
    ...(value.presentation === 'foreground' ||
    value.presentation === 'background' ||
    value.presentation === 'deferred'
      ? { presentation: value.presentation }
      : {}),
    ...(value.reason === 'automation_turn' ||
    value.reason === 'browser_handoff' ||
    value.reason === 'unknown_turn'
      ? { reason: value.reason }
      : {}),
    ...(typeof value.deferred === 'number' ? { deferred: value.deferred } : {}),
    opened: value.opened,
    failed: value.failed,
    files: files.filter(
      (file): file is ShowFilesRendererResult['files'][number] => file !== null,
    ),
  };
}

export async function requestShowFiles(
  input: {
    intent?: 'user' | 'agent';
    files: ShowFileRequest[];
    target: ShowFilesWorkspaceTarget;
    origin: ShowFilesChatOrigin;
    cwd?: string;
    reuseBrowserId?: string;
    focusReturnId?: string;
  },
  surfaces: AppAdvisorRendererToolSurfaces,
  options?: { followChatDriver?: boolean },
): Promise<ShowFilesRendererResult> {
  // Resolve once before any await. A later scheduled turn must never lend its
  // provenance to this request (or borrow a preceding human turn's identity).
  const turn = capturePresentationTurn(input.origin);
  const policy = showFilesPresentationPolicy({
    intent: input.intent ?? 'agent',
    source: turn?.source,
    handoffId: browserHandoffs.snapshot(
      input.target.projectId,
      input.target.worktreeId,
    ).handoff?.handoffId,
  });
  const files = normalizeFiles(input.files, input.cwd);
  if (policy.presentation === 'deferred') {
    return {
      ...policy,
      opened: 0,
      failed: 0,
      activated: false,
      deferred: files.length,
      files: files.map((file) => ({
        path: file.path,
        ok: true,
        opened: false,
        activated: false,
        deferred: true,
      })),
    };
  }
  const request: AppAdvisorRendererToolRequest = {
    kind: 'show_files',
    requestId: randomUUID(),
    payload: {
      files,
      intent: input.intent ?? 'agent',
      ...policy,
      target: input.target,
      origin: input.origin,
      ...(input.focusReturnId ? { focusReturnId: input.focusReturnId } : {}),
      ...(input.reuseBrowserId ? { reuseBrowserId: input.reuseBrowserId } : {}),
    },
  };
  const response = await (options
    ? requestAppAdvisorRendererTool(request, surfaces, options)
    : requestAppAdvisorRendererTool(request, surfaces));
  if (!response.result) {
    throw new Error(
      response.error?.message ?? 'Unable to open requested files.',
    );
  }
  return { ...policy, ...resultFrom(response.result) };
}

export function mainWindowOnlyToolSurfaces(
  getWindow: () => BrowserWindow | null,
): AppAdvisorRendererToolSurfaces {
  return {
    getMainWindow: getWindow,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: () =>
      Promise.resolve({
        open: false,
        focused: false,
      }),
    ensureAppAdvisorWindow: () =>
      Promise.resolve({
        open: false,
        focused: false,
      }),
  };
}
