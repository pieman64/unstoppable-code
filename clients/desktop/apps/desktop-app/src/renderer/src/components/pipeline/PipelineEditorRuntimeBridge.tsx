import { useEffect, useRef, type JSX } from 'react';
import {
  getRendererToolRequestScopeKey,
  type PipelineEditorRendererToolRequest,
  type PipelineEditorRendererToolResponse,
  type PipelineEditorValidationIssue,
} from '@canopy/desktop-shared/types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import {
  serializePipelineToYaml,
  tryParseAndValidateYaml,
} from '@/lib/pipeline-yaml';
import { getDraftValidation } from '@/lib/pipelineEditor';
import {
  usePipelineEditorBridgeStore,
  type PipelineEditorBridgeState,
  type PipelineEditorControllerAdapter,
  type PipelineEditorControllerTarget,
  type PipelineEditorPageController,
} from '@/stores/pipelineEditorBridgeStore';
import { useNavigationStore } from '@/stores/navigationStore';

const READONLY_MESSAGE =
  'This pipeline is read-only — duplicate it to make changes before editing.';
const NO_EDITOR_MESSAGE =
  'No pipeline is open. Open or create a pipeline first, then edit it.';
const NO_PIPELINE_LOADED_MESSAGE =
  'The pipeline editor is still loading. Try again in a moment.';
const NO_PAGE_MESSAGE = 'The Pipelines page is not available.';
const KEPT_EDITING_MESSAGE = 'The person kept editing unsaved changes.';
const PAGE_CONTROLLER_TIMEOUT_MS = 5_000;
const EDITOR_CONTROLLER_TIMEOUT_MS = 5_000;
const BRIDGE_WAIT_INTERVAL_MS = 25;
const SHARED_PIPELINE_SAVE_IMPACT_MESSAGE =
  'People using this pipeline in their automations will need to approve your changes before they run again.';

async function sharedPipelineSaveImpactNote(
  editorController: PipelineEditorControllerAdapter,
): Promise<string | undefined> {
  const remoteId = editorController.getTarget().sharedRemoteId;
  if (!remoteId) return undefined;
  try {
    const result = await window.pipelines.getSharedUpdateImpact(remoteId);
    if (result.success && result.data && result.data.automations.length === 0) {
      return undefined;
    }
  } catch {
    // Unknown impact fails toward the same publisher warning as the UI save.
  }
  return SHARED_PIPELINE_SAVE_IMPACT_MESSAGE;
}

function toValidationIssues(
  pipeline: Pipeline,
): PipelineEditorValidationIssue[] {
  return getDraftValidation(pipeline).map((issue) => ({
    type: issue.type,
    path: issue.path,
    message: issue.message,
  }));
}

/**
 * Renderer end of the pipeline-editor renderer-tool round-trip. Mirrors
 * {@link AppAdvisorRuntimeBridge}: it subscribes to main-process tool requests
 * over `window.api.pipelineEditor.onToolRequest`, applies each request to the
 * mounted editor (or to page/navigation state when no editor is mounted) via
 * the {@link usePipelineEditorBridgeStore}, and replies with
 * `completeToolRequest`.
 *
 * Mounted once at the `PipelinesPage` root (outside the list/editor switch) so
 * it lives across list↔editor navigation.
 */
export function PipelineEditorRuntimeBridge(): JSX.Element {
  const responseCacheRef = useRef<
    Map<string, PipelineEditorRendererToolResponse>
  >(new Map());
  const pendingEditorTargetRef = useRef<PipelineEditorControllerTarget | null>(
    null,
  );

  useEffect(() => {
    const dispose = window.api.pipelineEditor.onToolRequest((request) => {
      void handleRequest(request);
    });
    return dispose;
    // `handleRequest` reads only the bridge store (via getState) and stable
    // module helpers; listing it would force a re-subscription each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <></>;

  async function handleRequest(
    request: PipelineEditorRendererToolRequest,
  ): Promise<void> {
    const { originChatId } = request;
    const cacheKey = getRendererToolRequestScopeKey(
      request.requestId,
      originChatId,
    );
    const cached = responseCacheRef.current.get(cacheKey);
    if (cached) {
      await window.api.pipelineEditor.completeToolRequest(cached);
      return;
    }

    let response: PipelineEditorRendererToolResponse;
    try {
      response = await routeRequest(request);
    } catch (error: unknown) {
      response = {
        requestId: request.requestId,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Pipeline editor renderer tool failed.',
      };
    }

    const scopedResponse = originChatId
      ? { ...response, originChatId }
      : response;
    cacheResponse(cacheKey, scopedResponse);
    await window.api.pipelineEditor.completeToolRequest(scopedResponse);
  }

  async function routeRequest(
    request: PipelineEditorRendererToolRequest,
  ): Promise<PipelineEditorRendererToolResponse> {
    const { requestId } = request;

    switch (request.kind) {
      case 'list': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        return {
          requestId,
          ok: true,
          pipelines: page.pageController.getPipelineRows(),
        };
      }

      case 'open': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        const opened = await page.pageController.openEditor(request.locator);
        if (!opened) {
          return { requestId, ok: false, error: KEPT_EDITING_MESSAGE };
        }
        pendingEditorTargetRef.current = {
          pipelineId: request.locator.pipelineId ?? null,
          cwd: request.locator.cwd,
          pipelineFilePath: request.locator.pipelineFilePath,
          sharedRemoteId: request.locator.sharedRemoteId,
        };
        return { requestId, ok: true };
      }

      case 'create': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        const draft = await page.pageController.openNewDraft();
        if (!draft) {
          return { requestId, ok: false, error: KEPT_EDITING_MESSAGE };
        }
        pendingEditorTargetRef.current = draft;
        return { requestId, ok: true };
      }

      case 'to_list': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        const left = await page.pageController.goToList();
        if (!left) {
          return { requestId, ok: false, error: KEPT_EDITING_MESSAGE };
        }
        pendingEditorTargetRef.current = null;
        return { requestId, ok: true };
      }

      case 'get_current':
        return handleGetCurrent(requestId);

      case 'set_yaml':
        return handleSetYaml(requestId, request.yaml);

      case 'save':
        return handleSave(requestId);

      default: {
        // Exhaustiveness guard for the current union shape.
        const _exhaustive: never = request;
        void _exhaustive;
        return {
          requestId,
          ok: false,
          error: 'Unsupported pipeline-editor renderer-tool request.',
        };
      }
    }
  }

  function handleGetCurrent(
    requestId: string,
  ): Promise<PipelineEditorRendererToolResponse> {
    return withReadyEditorController(requestId, (readyEditorController) => {
      const editor = readyEditorController.getEditor();
      if (readyEditorController.isRawMode()) {
        const rawError = readyEditorController.getRawYamlError();
        const rawYamlText = readyEditorController.getRawYamlText();
        const rawValidation:
          | { success: true; pipeline: Pipeline }
          | { success: false; error: string } =
          rawError !== null
            ? { success: false, error: rawError }
            : tryParseAndValidateYaml(rawYamlText);
        return {
          requestId,
          ok: true,
          pipelineYaml: rawYamlText,
          isDirty: readyEditorController.isRawYamlDirty() || editor.isDirty,
          validation: rawValidation.success
            ? toValidationIssues(rawValidation.pipeline)
            : [{ type: 'error', path: '', message: rawValidation.error }],
          readonly: editor.readonly,
        };
      }

      return {
        requestId,
        ok: true,
        pipelineYaml: serializePipelineToYaml(editor.pipeline as Pipeline),
        isDirty: editor.isDirty,
        validation: editor.validation.map((issue) => ({
          type: issue.type,
          path: issue.path,
          message: issue.message,
        })),
        readonly: editor.readonly,
      };
    });
  }

  async function withReadyEditorController(
    requestId: string,
    handleReady: (
      editorController: PipelineEditorControllerAdapter,
    ) =>
      | PipelineEditorRendererToolResponse
      | Promise<PipelineEditorRendererToolResponse>,
  ): Promise<PipelineEditorRendererToolResponse> {
    const ready = await waitForReadyEditorController(requestId);
    if (!ready.ok) {
      return ready.response;
    }
    return handleReady(ready.editorController);
  }

  async function handleSetYaml(
    requestId: string,
    yamlText: string,
  ): Promise<PipelineEditorRendererToolResponse> {
    return withReadyEditorController(
      requestId,
      async (readyEditorController) => {
        const editor = readyEditorController.getEditor();
        if (editor.readonly) {
          return {
            requestId,
            ok: false,
            error: READONLY_MESSAGE,
            readonly: true,
          };
        }

        const result = tryParseAndValidateYaml(yamlText);
        if (!result.success) {
          // Parse/validation failure: report it without mutating the editor.
          return {
            requestId,
            ok: false,
            error: result.error,
            readonly: false,
          };
        }

        const impactNote = await sharedPipelineSaveImpactNote(
          readyEditorController,
        );
        // Apply + persist. Pass the parsed pipeline as the explicit save override
        // because `save()` defaults to the closure pipeline, which React has not
        // re-rendered to the new value yet after `replaceEntirePipeline`.
        editor.replaceEntirePipeline(result.pipeline);
        const saved = await editor.save(result.pipeline);

        // Keep the visible raw textarea in sync so a later view-switch does not
        // clobber the agent's change with a stale competing edit.
        if (readyEditorController.isRawMode()) {
          readyEditorController.setRawYamlText(yamlText);
          readyEditorController.clearRawYamlError();
          readyEditorController.resetRawYamlBaseline(yamlText);
        }

        return {
          requestId,
          ok: saved !== null,
          ...(saved && impactNote ? { note: impactNote } : {}),
          ...(saved
            ? {}
            : {
                error:
                  readyEditorController.getEditor().error ??
                  'Failed to save the pipeline.',
              }),
          pipelineYaml: serializePipelineToYaml(result.pipeline),
          isDirty: !saved,
          validation: toValidationIssues(result.pipeline),
          readonly: false,
        };
      },
    );
  }

  async function handleSave(
    requestId: string,
  ): Promise<PipelineEditorRendererToolResponse> {
    return withReadyEditorController(
      requestId,
      async (readyEditorController) => {
        const editor = readyEditorController.getEditor();
        if (editor.readonly) {
          return {
            requestId,
            ok: false,
            error: READONLY_MESSAGE,
            readonly: true,
          };
        }

        // Raw mode with unsaved buffer edits: validate + persist the buffer first
        // (mirrors the editor session's save).
        if (
          readyEditorController.isRawMode() &&
          readyEditorController.isRawYamlDirty()
        ) {
          const rawText = readyEditorController.getRawYamlText();
          if (!readyEditorController.applyRawYaml()) {
            return {
              requestId,
              ok: false,
              error:
                readyEditorController.getRawYamlError() ??
                'Failed to apply raw pipeline YAML.',
            };
          }
          const result = tryParseAndValidateYaml(rawText);
          if (!result.success) {
            return { requestId, ok: false, error: result.error };
          }
          const impactNote = await sharedPipelineSaveImpactNote(
            readyEditorController,
          );
          const saved = await editor.save(result.pipeline);
          const didSave = saved !== null;
          if (didSave) {
            readyEditorController.resetRawYamlBaseline(rawText);
          }
          return {
            requestId,
            ok: didSave,
            ...(didSave && impactNote ? { note: impactNote } : {}),
            ...(didSave
              ? {}
              : {
                  error:
                    readyEditorController.getEditor().error ??
                    'Failed to save the pipeline.',
                }),
            pipelineYaml: serializePipelineToYaml(result.pipeline),
            isDirty: !didSave,
            validation: toValidationIssues(result.pipeline),
            readonly: false,
          };
        }

        const impactNote = await sharedPipelineSaveImpactNote(
          readyEditorController,
        );
        const saved = await editor.save();
        const didSave = saved !== null;
        const current = readyEditorController.getEditor();
        return {
          requestId,
          ok: didSave,
          ...(didSave && impactNote ? { note: impactNote } : {}),
          ...(didSave
            ? {}
            : { error: current.error ?? 'Failed to save the pipeline.' }),
          ...(current.pipeline
            ? {
                pipelineYaml: serializePipelineToYaml(current.pipeline),
                validation: toValidationIssues(current.pipeline),
              }
            : {}),
          isDirty: didSave ? false : current.isDirty,
          readonly: false,
        };
      },
    );
  }

  function cacheResponse(
    cacheKey: string,
    response: PipelineEditorRendererToolResponse,
  ): void {
    responseCacheRef.current.set(cacheKey, response);
    if (responseCacheRef.current.size > 100) {
      const firstKey = responseCacheRef.current.keys().next().value;
      if (firstKey !== undefined) {
        responseCacheRef.current.delete(firstKey);
      }
    }
  }

  function getReadyEditorController(
    requestId: string,
    editorController: PipelineEditorControllerAdapter | null,
  ):
    | { ok: true; editorController: PipelineEditorControllerAdapter }
    | { ok: false; response: PipelineEditorRendererToolResponse } {
    if (!editorController) {
      return {
        ok: false,
        response: {
          requestId,
          ok: false,
          error: pendingEditorTargetRef.current
            ? NO_PIPELINE_LOADED_MESSAGE
            : NO_EDITOR_MESSAGE,
        },
      };
    }

    const pendingTarget = pendingEditorTargetRef.current;
    if (pendingTarget) {
      if (!targetsMatch(editorController.getTarget(), pendingTarget)) {
        return {
          ok: false,
          response: {
            requestId,
            ok: false,
            error: NO_PIPELINE_LOADED_MESSAGE,
          },
        };
      }

      const editor = editorController.getEditor();
      if (editor.loading) {
        return {
          ok: false,
          response: {
            requestId,
            ok: false,
            error: NO_PIPELINE_LOADED_MESSAGE,
          },
        };
      }
      if (!editor.pipeline) {
        pendingEditorTargetRef.current = null;
        return {
          ok: false,
          response: {
            requestId,
            ok: false,
            error: editor.error ?? 'Failed to load the requested pipeline.',
          },
        };
      }
      pendingEditorTargetRef.current = null;
    }

    const editor = editorController.getEditor();
    if (editor.loading || !editor.pipeline) {
      return {
        ok: false,
        response: { requestId, ok: false, error: NO_PIPELINE_LOADED_MESSAGE },
      };
    }

    return { ok: true, editorController };
  }

  async function getReadyPageController(
    requestId: string,
  ): Promise<
    | { ok: true; pageController: PipelineEditorPageController }
    | { ok: false; response: PipelineEditorRendererToolResponse }
  > {
    const current = usePipelineEditorBridgeStore.getState().pageController;
    if (current) {
      return { ok: true, pageController: current };
    }

    useNavigationStore.getState().navigate('workflows-library');

    const pageController = await waitForBridgeState(
      (state) => state.pageController,
      PAGE_CONTROLLER_TIMEOUT_MS,
    );
    if (!pageController) {
      return {
        ok: false,
        response: {
          requestId,
          ok: false,
          error: `${NO_PAGE_MESSAGE} Timed out waiting for it to mount.`,
        },
      };
    }
    return { ok: true, pageController };
  }

  async function waitForReadyEditorController(
    requestId: string,
  ): Promise<
    | { ok: true; editorController: PipelineEditorControllerAdapter }
    | { ok: false; response: PipelineEditorRendererToolResponse }
  > {
    const initial = getReadyEditorController(
      requestId,
      usePipelineEditorBridgeStore.getState().editorController,
    );
    if (initial.ok || initial.response.error !== NO_PIPELINE_LOADED_MESSAGE) {
      return initial;
    }
    if (!pendingEditorTargetRef.current) {
      return initial;
    }

    useNavigationStore.getState().navigate('workflows-library');

    const ready = await waitForBridgeCondition(() => {
      const next = getReadyEditorController(
        requestId,
        usePipelineEditorBridgeStore.getState().editorController,
      );
      return next.ok || next.response.error !== NO_PIPELINE_LOADED_MESSAGE
        ? next
        : null;
    }, EDITOR_CONTROLLER_TIMEOUT_MS);

    return (
      ready ?? {
        ok: false,
        response: {
          requestId,
          ok: false,
          error: NO_PIPELINE_LOADED_MESSAGE,
        },
      }
    );
  }
}

function targetsMatch(
  current: PipelineEditorControllerTarget,
  expected: PipelineEditorControllerTarget,
): boolean {
  return (
    current.pipelineId === expected.pipelineId &&
    current.draftKey === expected.draftKey &&
    current.cwd === expected.cwd &&
    current.pipelineFilePath === expected.pipelineFilePath &&
    current.sharedRemoteId === expected.sharedRemoteId
  );
}

function waitForBridgeState<T>(
  select: (state: PipelineEditorBridgeState) => T | null,
  timeoutMs: number,
): Promise<T | null> {
  return waitForBridgeCondition(
    () => select(usePipelineEditorBridgeStore.getState()),
    timeoutMs,
  );
}

function waitForBridgeCondition<T>(
  select: () => T | null,
  timeoutMs: number,
): Promise<T | null> {
  const current = select();
  if (current) {
    return Promise.resolve(current);
  }

  return new Promise((resolve) => {
    let done = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      if (interval !== null) {
        clearInterval(interval);
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const check = (): void => {
      const next = select();
      if (next) {
        finish(next);
      }
    };
    const unsubscribe = usePipelineEditorBridgeStore.subscribe(check);
    const timer = setTimeout(() => finish(null), timeoutMs);
    interval = setInterval(check, BRIDGE_WAIT_INTERVAL_MS);
    check();
  });
}
