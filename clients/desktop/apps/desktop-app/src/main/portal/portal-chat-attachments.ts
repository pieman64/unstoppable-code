import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import { filesystemErrorCode } from '@canopy/core-runtime/node/workspace/cowork-folder';
import {
  ensureWorkspaceWriteDirectory,
  assertCoworkChatRootPresent,
} from '../lib/cowork-folder-guard';
import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CLOUD_ATTACHMENT_MAX_BYTES,
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
  isCloudAttachmentFilename,
  isPortalAttachmentMediaType,
  portalAttachmentMediaTypeForFilename,
} from '@canopy/protocol/cloud-attachments';
import type { PortalChatCloudAttachmentRef } from '@canopy/desktop-shared/types';
import { prepareAgentAttachmentsDir } from '../lib/agent-attachments';
import {
  consumePortalChatAttachment,
  downloadPortalChatAttachment,
} from './canopy-portal-client';

/**
 * Phone/browser-originated chat attachments for a paired desktop.
 *
 * A `portal.chat.send` may carry `cloudAttachments`: refs to blobs the client
 * uploaded to the web service. This module turns them into ordinary
 * desktop attachments — files inside the chat target's attachments directory —
 * so the rest of the send path (`attachmentPaths`, prompt injection,
 * containment checks) is unchanged. Every failure is fail-closed: no partial
 * files, no message persisted.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export class PortalChatAttachmentError extends Error {
  constructor(
    readonly code: 'invalid_payload' | 'execution_failed',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PortalChatAttachmentError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRef(value: unknown, index: number): PortalChatCloudAttachmentRef {
  const fail = (reason: string): never => {
    throw new PortalChatAttachmentError(
      'invalid_payload',
      `cloudAttachments[${index}]: ${reason}`,
    );
  };
  if (!isRecord(value)) return fail('must be an object');
  const {
    attachmentId,
    filename,
    mediaType,
    size,
    contentSha256,
    storageKind,
    source,
  } = value;
  if (typeof attachmentId !== 'string' || !UUID_PATTERN.test(attachmentId)) {
    return fail('attachmentId must be a UUID');
  }
  if (!isCloudAttachmentFilename(filename)) {
    return fail('filename is invalid');
  }
  if (!isPortalAttachmentMediaType(mediaType)) {
    return fail('mediaType is not supported');
  }
  // The declared media type is what downstream surfaces (prompt injection,
  // transcript projection, the Attachments card) read, while the extension is
  // what the file on disk carries. A ref that disagrees — `payload.sh`
  // declared `text/plain` — would be written under a name the rest of the app
  // never classifies the same way it was accepted, so reject the pair rather
  // than trusting either half of it.
  if (portalAttachmentMediaTypeForFilename(filename) !== mediaType) {
    return fail('mediaType does not match the filename extension');
  }
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > CLOUD_ATTACHMENT_MAX_BYTES
  ) {
    return fail('size is out of range');
  }
  if (
    typeof contentSha256 !== 'string' ||
    !SHA256_PATTERN.test(contentSha256)
  ) {
    return fail('contentSha256 must be 64 hex characters');
  }
  if (storageKind !== 'blob') return fail("storageKind must be 'blob'");
  if (typeof source !== 'string') return fail('source must be a string');
  return {
    attachmentId,
    filename,
    mediaType,
    size,
    contentSha256,
    storageKind,
    source,
  };
}

/**
 * Strict parse of the wire `cloudAttachments` array. Unlike `fileReferences`,
 * a malformed entry fails the whole send: silently dropping an attachment the
 * user chose would send a message that no longer says what they meant.
 */
export function readPortalChatCloudAttachmentRefs(
  value: unknown,
): PortalChatCloudAttachmentRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PortalChatAttachmentError(
      'invalid_payload',
      'cloudAttachments must be an array',
    );
  }
  if (value.length > CLOUD_ATTACHMENTS_MAX_PER_MESSAGE) {
    throw new PortalChatAttachmentError(
      'invalid_payload',
      `At most ${CLOUD_ATTACHMENTS_MAX_PER_MESSAGE} attachments per message.`,
    );
  }
  const refs = value.map(readRef);
  const ids = new Set(refs.map((ref) => ref.attachmentId));
  if (ids.size !== refs.length) {
    throw new PortalChatAttachmentError(
      'invalid_payload',
      'cloudAttachments contains duplicates',
    );
  }
  return refs;
}

export interface MaterializePortalChatAttachmentsInput {
  refs: readonly PortalChatCloudAttachmentRef[];
  projectId: string;
  worktreeId: string;
  /** Active portal session id; null when the portal is not running. */
  sessionId: string | null;
  /** Portal command expiry used to stop before completion becomes impossible. */
  expiresAt?: string | null;
}

/**
 * Whole-operation budget for materializing one message's attachments.
 *
 * The per-request timeout in `downloadPortalChatAttachment` bounds a single
 * attempt, but `requestCanopyCloudBinary` retries a GET twice with a fresh
 * timeout each time and the refs download one after another — so a message at
 * the per-message ref cap could occupy the serial portal command loop for
 * many minutes while every other command waits behind it. One deadline across
 * all refs keeps that bounded, and the failure is retryable because a slow
 * network is exactly the case a client should be able to try again.
 */
export const PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS = 120_000;
const PORTAL_ATTACHMENT_EXPIRY_SAFETY_MS = 5_000;

function materializationBudgetMs(expiresAt: string | null | undefined): number {
  if (expiresAt == null) return PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS;
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs))
    return PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS;
  return Math.max(
    0,
    Math.min(
      PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS,
      expiryMs - Date.now() - PORTAL_ATTACHMENT_EXPIRY_SAFETY_MS,
    ),
  );
}

function deadlineError(): PortalChatAttachmentError {
  return new PortalChatAttachmentError(
    'execution_failed',
    'Attachments took too long to download.',
    true,
  );
}

/**
 * Download every ref, verify it against the declared size and sha256, and
 * write it into the chat target's attachments directory. Returns the absolute
 * paths in ref order. On any failure every file written so far is removed and
 * the error carries the adapter failure code to report.
 *
 * The blobs are deliberately NOT consumed here: the send can still be refused
 * (policy, billing, a split lock) or come back as a retryable `conflict` after
 * this returns, and a consumed blob would make that retry impossible. The
 * caller consumes once the send is accepted (`consumePortalChatAttachments`).
 */
export async function materializePortalChatAttachments(
  input: MaterializePortalChatAttachmentsInput,
): Promise<string[]> {
  if (input.refs.length === 0) return [];
  const sessionId = input.sessionId;
  if (sessionId === null) {
    throw new PortalChatAttachmentError(
      'execution_failed',
      'Attachments need an active Remote Control session on the desktop.',
    );
  }
  const dir = await prepareAgentAttachmentsDir(
    input.projectId,
    input.worktreeId,
  );
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, materializationBudgetMs(input.expiresAt));
  const written: string[] = [];
  try {
    for (const ref of input.refs) {
      let bytes: Buffer;
      try {
        bytes = await downloadPortalChatAttachment({
          sessionId,
          attachmentId: ref.attachmentId,
          signal: controller.signal,
        });
      } catch {
        // An aborted request reports whatever the transport chose to throw,
        // so the signal — not the error shape — decides which failure this is.
        if (controller.signal.aborted) throw deadlineError();
        throw new PortalChatAttachmentError(
          'execution_failed',
          `Couldn't upload ${ref.filename}. Retry or remove it.`,
          true,
        );
      }
      // A download that resolved just as the deadline fired still spent the
      // whole budget; stop rather than starting the next ref.
      if (controller.signal.aborted) throw deadlineError();
      if (bytes.byteLength !== ref.size) {
        throw new PortalChatAttachmentError(
          'execution_failed',
          `${ref.filename} did not download completely.`,
          true,
        );
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== ref.contentSha256) {
        throw new PortalChatAttachmentError(
          'execution_failed',
          `${ref.filename} failed its integrity check.`,
        );
      }
      const itemDir = join(dir, `portal-${randomUUID()}`);
      await ensureWorkspaceWriteDirectory(itemDir);
      const path = join(itemDir, ref.filename);
      try {
        await writeFile(path, bytes, { flag: 'wx' });
        written.push(path);
      } catch (error) {
        await rm(itemDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    }
  } catch (error) {
    await Promise.all(
      written.map((path) =>
        rm(dirname(path), { recursive: true, force: true }).catch(
          () => undefined,
        ),
      ),
    );
    if (readCoworkFolderMissing(error)) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(String(filesystemErrorCode(error))))
      await assertCoworkChatRootPresent(input.projectId, input.worktreeId);
    if (error instanceof PortalChatAttachmentError) throw error;
    throw new PortalChatAttachmentError(
      'execution_failed',
      error instanceof Error ? error.message : 'Attachment could not be saved.',
    );
  } finally {
    clearTimeout(deadline);
  }
  return written;
}

/** Remove local files created for a send that did not commit. */
export async function removeMaterializedPortalChatAttachments(
  paths: readonly string[],
): Promise<void> {
  await Promise.all(
    paths.map((path) =>
      rm(dirname(path), { recursive: true, force: true }).catch(
        () => undefined,
      ),
    ),
  );
}

/**
 * Best-effort release of the uploaded blobs once the send has been accepted.
 *
 * Deliberately never throws and never takes the materialize deadline's signal:
 * the files are already on disk and the message is already accepted, the
 * server's own sweep is the backstop, and a failed DELETE must not turn an
 * accepted send into a reported failure.
 */
export async function consumePortalChatAttachments(input: {
  sessionId: string | null;
  attachmentIds: readonly string[];
}): Promise<void> {
  const sessionId = input.sessionId;
  if (sessionId === null || input.attachmentIds.length === 0) return;
  await Promise.all(
    input.attachmentIds.map((attachmentId) =>
      consumePortalChatAttachment({ sessionId, attachmentId }).catch(
        () => undefined,
      ),
    ),
  );
}
