import { isAbsolute } from 'node:path';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { isValidAgentModelSlug } from '@canopy/desktop-shared/types/agent-models';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  isAddressableSharedPipelineRemoteId,
  isSharedPipelineLocalId,
  parseSharedPipelineLocalId,
} from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import { validateId as validateCoreId } from '@canopy/core-runtime/node/identifiers';
export { IdentifierValidationError } from './identifier-validation-error';

const MAX_MESSAGE_ANCHOR_ID_LENGTH = 256;

export function validateId(
  value: unknown,
  label: string,
): asserts value is string {
  validateCoreId(value, label);
}

const LOCAL_AGENT_MODEL_ID_PREFIX = 'agent_model_';

/** A saved local Agent id: `agent_model_` followed by a valid slug. */
export function validateAgentModelId(value: unknown, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith(LOCAL_AGENT_MODEL_ID_PREFIX) ||
    !isValidAgentModelSlug(value.slice(LOCAL_AGENT_MODEL_ID_PREFIX.length))
  ) {
    throw new Error(`Invalid ${label}: must be a valid Agent model id`);
  }
}

/** Cloud MCP server refs: `custom:<id>` keys and legacy `account:<id>` refs. */
const MCP_SERVER_REF_PREFIXES = ['custom:', 'account:'] as const;

/**
 * An MCP server id as selections store it: a device id or curated key that
 * passes {@link validateId}, or a cloud ref whose part after the prefix does.
 */
export function validateMcpServerRefId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value === 'string') {
    const prefix = MCP_SERVER_REF_PREFIXES.find((candidate) =>
      value.startsWith(candidate),
    );
    if (prefix !== undefined) {
      validateId(value.slice(prefix.length), label);
      return;
    }
  }
  validateId(value, label);
}

const MEMORY_REPORT_ID_RE = /^(?:report|auto)-\d{8}T\d{6}Z(?:-[1-9]\d{0,5})?$/;

/**
 * A memory report or automatic dump folder name, such as
 * `report-20261021T162619Z` or `auto-20261021T162619Z-2`. The uppercase `T`
 * and `Z` are part of the UTC timestamp, so {@link validateId} cannot be used.
 */
export function isMemoryReportId(value: unknown): value is string {
  return typeof value === 'string' && MEMORY_REPORT_ID_RE.test(value);
}

export function validateMessageAnchorId(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MESSAGE_ANCHOR_ID_LENGTH
  ) {
    throw new Error(
      `${label} must be a nonempty string of at most ${String(MAX_MESSAGE_ANCHOR_ID_LENGTH)} characters.`,
    );
  }
  // Transcript anchors are not repository entity ids. Main deliberately mints
  // composite ids as `<chatId>:<mutationId>:<sequence>`, and provider block
  // ids may also contain `_` or `.`. Keep that distinct contract explicit and
  // bounded while rejecting whitespace, path separators, and other syntax.
  if (
    value.split('').some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`invalid ${label}: control characters are not allowed.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`invalid ${label}: unsafe anchor id.`);
  }
}

export function validateWorktreeChatScope(
  projectId: unknown,
  worktreeId: unknown,
): void {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
}

export function validateAbsolutePath(value: string, label: string): void {
  if (!value || !isAbsolute(value)) {
    throw new Error(`Invalid ${label}: must be an absolute path`);
  }
}

export function validateOptionalRepoId(
  repoId: string | undefined,
  label: string,
): void {
  if (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID) {
    validateId(repoId, label);
  }
}

export function validatePipelineDefinitionLocator(
  value: unknown,
  label: string,
): void {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${label}: must be a pipeline identifier`);
  }
  if (isSharedPipelineLocalId(value)) {
    // `shared:<serverId>:<remoteId>` is the only pipeline id with no file and
    // no local store entry behind it; the colons alone would fail the safe-ID
    // charset below, so shared rows offered by the portal picker (CAN-3021)
    // need their own shape check. Resolution is a Canopy Cloud fetch keyed by
    // `remoteId`, never a filesystem path.
    const parsed = parseSharedPipelineLocalId(value);
    if (
      !parsed ||
      parsed.serverId !== CANOPY_CLOUD_SERVER_ID ||
      !isAddressableSharedPipelineRemoteId(parsed.remoteId)
    ) {
      throw new Error(
        `Invalid ${label}: must identify a ${CANOPY_CLOUD_SERVER_ID} shared pipeline`,
      );
    }
    return;
  }

  if (!value.startsWith('project--')) {
    validateId(value, label);
    return;
  }

  // `project--` ids embed the discovered YAML file's repo-relative path, so
  // segments may use any filename characters and cannot be held to the
  // lowercase safe-ID charset. Resolution is a catalog lookup against
  // discovered pipelines, never direct filesystem access; this check is
  // defense-in-depth against traversal and control-character payloads.
  const relativePath = value.slice('project--'.length);
  // eslint-disable-next-line no-control-regex
  const hasControlCharacters = /[\u0000-\u001f\u007f]/.test(relativePath);
  if (
    relativePath.length > 512 ||
    !/\.ya?ml$/i.test(relativePath) ||
    relativePath.includes('\\') ||
    hasControlCharacters
  ) {
    throw new Error(`Invalid ${label}: must identify a YAML pipeline file`);
  }
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`Invalid ${label}: must identify a YAML pipeline file`);
  }
}
