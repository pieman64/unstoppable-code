import { readFile, rm } from 'node:fs/promises';
import {
  FEEDBACK_REPORT_TYPES,
  type FeedbackArea,
  type FeedbackContextSnapshot,
  type FeedbackPrepareRequest,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResponse,
} from '@canopy/desktop-shared/types';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  cleanupStaleTemporaryFeedbackBundles,
  prepareFeedbackBundle,
  releaseTemporaryFeedbackBundle,
} from './feedback-bundle';

const FEEDBACK_REPORTS_PATH = '/api/v1/feedback/reports';
const FEEDBACK_ATTACHMENT_COMMIT_PATH =
  '/api/v1/feedback/reports/attachment-commit';
// Matches `MAX_FEEDBACK_UPLOAD_BYTES` in apps/web/src/lib/uploads/gcs-config.ts:
// the server issues no upload URL for a larger bundle.
const FEEDBACK_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Wire contract for the `POST /api/v1/feedback/reports` request body. Kept in
 * sync with the web route handler in
 * `apps/web/src/app/api/v1/feedback/reports/route.ts`.
 */
interface FeedbackReportCreatePayload {
  type: FeedbackSubmitRequest['type'];
  title?: string;
  description: string;
  context: FeedbackContextSnapshot;
  // Wire field intentionally named `attachDiagnostics`, not `includeDiagnostics`:
  // Unstoppable Domains' Fastly Next-Gen WAF flags the literal JSON key
  // `"includeDiagnostics":` as an attack signal and blocks the request at the
  // edge (403) before it reaches this route. The renderer/IPC field is still
  // `includeDiagnostics`; only the HTTP body key diverges. Keep this in sync
  // with `validateFeedbackReportBody` in apps/web.
  attachDiagnostics: boolean;
  diagnosticsSizeBytes?: number;
}

interface FeedbackReportCreateResponse {
  // `reportId` (the internal issue id) stays inside the main process: it is only
  // used to commit the diagnostics attachment and is never surfaced to the
  // renderer/user. The backend also returns an issue identifier/URL, but we
  // deliberately do not read or forward them to avoid leaking internal details.
  reportId: string;
  uploadUrl?: string;
  filePath?: string;
}

interface FeedbackAttachmentCommitResponse {
  ok: boolean;
}

/**
 * Orchestrates a first-class feedback submission:
 *   1. Build the diagnostics zip to a temp file (when requested).
 *   2. Create the Linear issue via the Canopy Cloud backend.
 *   3. Upload the zip to the GCS signed URL returned by step 2.
 *   4. Commit the attachment so the backend attaches it to the issue.
 *   5. Clean up the temp file and return a minimal success marker (no internal
 *      issue identifier or URL is surfaced to the renderer/user).
 *
 * Diagnostics upload/attachment is best-effort: a failure there does not fail
 * the submission because the issue has already been filed.
 */
export async function submitFeedback(
  request: FeedbackSubmitRequest,
): Promise<FeedbackSubmitResponse> {
  validateSubmitRequest(request);

  const description = request.description.trim();
  const title = request.title?.trim();

  let bundlePath: string | undefined;
  let bundleSizeBytes: number | undefined;
  if (request.includeDiagnostics) {
    // The sweep is deliberately best-effort even if a host adapter fails.
    await cleanupStaleTemporaryFeedbackBundles().catch(() => undefined);
    try {
      const prepareRequest = buildPrepareRequest(request, description);
      let bundle = await prepareFeedbackBundle(prepareRequest, {
        destination: 'temp',
      });
      if (bundle.sizeBytes > FEEDBACK_UPLOAD_MAX_BYTES) {
        // Crash dumps are the bulk that can cross the server limit; without an
        // upload URL the report would lose its logs too, so rebuild without them.
        await discardTemporaryBundle(bundle.absolutePath);
        bundle = await prepareFeedbackBundle(prepareRequest, {
          destination: 'temp',
          includeCrashDumps: false,
        });
      }
      bundlePath = bundle.absolutePath;
      bundleSizeBytes = bundle.sizeBytes;
    } catch (error) {
      logMainProcessWarn('Feedback diagnostics preparation failed', {
        category: preparationFailureCategory(error),
      });
    }
  }

  try {
    const createPayload: FeedbackReportCreatePayload = {
      type: request.type,
      description,
      context: request.context,
      attachDiagnostics: request.includeDiagnostics && bundlePath !== undefined,
      ...(title && title.length > 0 ? { title } : {}),
      ...(bundleSizeBytes !== undefined
        ? { diagnosticsSizeBytes: bundleSizeBytes }
        : {}),
    };

    const created = await requestCanopyCloudJson<FeedbackReportCreateResponse>(
      FEEDBACK_REPORTS_PATH,
      {
        method: 'POST',
        body: JSON.stringify(createPayload),
      },
    );

    if (
      bundlePath !== undefined &&
      created.uploadUrl !== undefined &&
      created.filePath !== undefined
    ) {
      await uploadAndCommitDiagnostics({
        bundlePath,
        uploadUrl: created.uploadUrl,
        filePath: created.filePath,
        reportId: created.reportId,
      });
    }

    return { submitted: true };
  } finally {
    if (bundlePath !== undefined) {
      await discardTemporaryBundle(bundlePath);
    }
  }
}

async function discardTemporaryBundle(bundlePath: string): Promise<void> {
  try {
    await rm(bundlePath, { force: true }).catch(() => undefined);
  } finally {
    releaseTemporaryFeedbackBundle(bundlePath);
  }
}

async function uploadAndCommitDiagnostics(params: {
  bundlePath: string;
  uploadUrl: string;
  filePath: string;
  reportId: string;
}): Promise<void> {
  try {
    const bytes = await readFile(params.bundlePath);
    const uploadResponse = await fetch(params.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    });
    if (!uploadResponse.ok) {
      return;
    }
    await requestCanopyCloudJson<FeedbackAttachmentCommitResponse>(
      FEEDBACK_ATTACHMENT_COMMIT_PATH,
      {
        method: 'POST',
        body: JSON.stringify({
          reportId: params.reportId,
          filePath: params.filePath,
        }),
      },
    );
  } catch {
    // Diagnostics attachment is best-effort — the issue is already filed.
  }
}

function validateSubmitRequest(request: FeedbackSubmitRequest): void {
  if (!FEEDBACK_REPORT_TYPES.includes(request.type)) {
    throw new Error(`Invalid feedback report type: ${request.type}`);
  }
  if (
    typeof request.description !== 'string' ||
    request.description.trim().length === 0
  ) {
    throw new Error('Feedback description is required');
  }
}

/**
 * Maps the auto-captured UI context onto a {@link FeedbackPrepareRequest} so the
 * existing diagnostics collectors run unchanged. The mapping is best-effort:
 * core diagnostics are always included regardless of the resolved area.
 */
function buildPrepareRequest(
  request: FeedbackSubmitRequest,
  description: string,
): FeedbackPrepareRequest {
  const context = request.context;
  const area = mapContextToArea(context);

  if (
    area === 'worktrees' &&
    isNonEmptyString(context.workspaceId) &&
    isNonEmptyString(context.worktreeId)
  ) {
    return {
      description,
      area,
      workspaceSelections: [
        {
          workspaceId: context.workspaceId,
          worktreeIds: [context.worktreeId],
        },
      ],
      includeChatDetails: true,
    };
  }

  if (area === 'chat' && isNonEmptyString(context.chatProjectId)) {
    return {
      description,
      area,
      chatProjectIds: [context.chatProjectId],
      includeChatDetails: true,
    };
  }

  return { description, area };
}

function mapContextToArea(context: FeedbackContextSnapshot): FeedbackArea {
  switch (context.activePage) {
    case 'pipelines':
    case 'workflows-library':
      return 'pipelines';
    case 'plugins':
      return 'plugins';
    case 'audit':
    case 'audit-trail':
      return 'audit-trail';
    case 'usage':
      return 'usage';
    case 'settings':
      return 'settings';
    case 'chat':
      return 'chat';
    case 'main':
      return isNonEmptyString(context.worktreeId) ? 'worktrees' : 'overview';
    default:
      return 'overview';
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function preparationFailureCategory(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'missing';
    case 'EACCES':
    case 'EPERM':
      return 'inaccessible';
    case 'EMFILE':
    case 'ENFILE':
      return 'resource-limit';
    case 'ENOSPC':
    case 'EIO':
      return 'io';
    default:
      return 'unknown';
  }
}
