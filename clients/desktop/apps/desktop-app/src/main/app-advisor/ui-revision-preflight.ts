import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import { requestAppAdvisorRendererTool } from '../ipc/app-advisor';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

/**
 * The renderer's stale-UI gate for legacy actions that now dispatch in main:
 * when the caller supplied a revision, refuse unless the UI still matches it.
 */
export async function legacyUiRevisionFailure(context: {
  surfaces: AppAdvisorToolRuntimeSurfaces;
  requestId: string;
  preflight: string;
  expectedUiRevision?: number;
  signal?: AbortSignal;
}): Promise<AppAdvisorActionResponse | null> {
  const { surfaces, requestId, preflight, expectedUiRevision, signal } =
    context;
  if (expectedUiRevision === undefined) return null;
  const state = await requestAppAdvisorRendererTool(
    { kind: 'get_current_ui_state', requestId: `${requestId}:${preflight}` },
    surfaces,
    ...(signal ? [{ signal }] : []),
  );
  if (!state.ok) return { ...state, requestId };
  if (!state.uiState)
    return {
      requestId,
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Current UI state is unavailable.',
      },
    };
  if (state.uiState.revision !== expectedUiRevision)
    return {
      requestId,
      ok: false,
      error: {
        code: 'stale_ui_state',
        message: `UI state revision ${state.uiState.revision} does not match expected ${expectedUiRevision}.`,
      },
    };
  return null;
}
