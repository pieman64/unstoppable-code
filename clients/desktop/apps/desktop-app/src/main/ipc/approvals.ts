import { z } from 'zod';
import { resolveApprovalSecretInput } from '../approvals/pending-approvals';
import {
  IPC_CHANNELS,
  type ApprovalDismissRequest,
  type ApprovalMode,
  type ApprovalModeSetRequest,
  type ApprovalRequestEvent,
  type ApprovalResolvedDefaultRequest,
  type ApprovalRespondRequest,
  type ApprovalRuleAddRequest,
  type ApprovalRuleRemoveRequest,
  type ApprovalRulesListRequest,
  type ApprovalRulesListResponse,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { validateId } from '../lib/validation';
import {
  pendingApprovalRequests,
  resolveApproval,
} from '../approvals/pending-approvals';
import {
  addWorkspaceApprovalRule,
  readWorkspaceApprovals,
  removeWorkspaceApprovalRule,
} from '../lib/approvals-persistence';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import {
  UNRESOLVABLE_TARGET_APPROVAL_MODE,
  readApprovalPreferencesForSurface,
  resolveApprovalMode,
  resolveApprovalProjectId,
  surfaceForChat,
} from '../lib/approval-mode-resolution';
import { readWorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import { markGlobalApprovalRulesChanged } from '../approvals/rule-revisions';
import { isApprovalPromptDecision } from '../approvals/approval-decision-validation';
import { isApprovalMode } from '@canopy/desktop-shared/lib/approval-engine';

type ApprovalModeSetter = (req: ApprovalModeSetRequest) => Promise<void>;

let approvalModeSetter: ApprovalModeSetter | null = null;

/**
 * Registers the session layer's handler for `approvalModeSet` requests. The
 * session/engine wiring that actually applies a mode change lands in a later
 * task; until a setter is registered the IPC handler no-ops (resolves)
 * instead of erroring.
 */
export function setApprovalModeSetter(fn: ApprovalModeSetter | null): void {
  approvalModeSetter = fn;
}

type ApprovalOwnerResolver = (sender: object) => object;

let approvalOwnerResolver: ApprovalOwnerResolver | null = null;

/**
 * Maps an IPC sender to the window whose approval prompts it may list and
 * answer. Remote control registers one so a paired computer's bridge acts as
 * the main window it mirrors; request and chat checks still apply.
 */
export function setApprovalOwnerResolver(
  fn: ApprovalOwnerResolver | null,
): void {
  approvalOwnerResolver = fn;
}

/** The sender first, then the window it acts for when that differs. */
function approvalOwnersFor(sender: object): object[] {
  const mirrored = approvalOwnerResolver?.(sender) ?? sender;
  return mirrored === sender ? [sender] : [sender, mirrored];
}

function requireWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error('workspaceId is required for project-scope approval rules');
  }
  validateId(workspaceId, 'workspaceId');
  return workspaceId;
}

const secretInputRequestSchema = z.strictObject({
  requestId: z.uuid(),
  bindingId: z.uuid(),
  projectId: z.string().min(1).max(256),
  worktreeId: z.string().min(1).max(256),
  chatId: z.string().min(1).max(256),
  secret: z.string().trim().max(16384),
});

export function registerApprovalHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.approvalSecretInput,
    (event, value: unknown): boolean => {
      const request = secretInputRequestSchema.safeParse(value);
      // Use the actual local sender; remote-control mirrors may not supply secrets.
      return (
        request.success &&
        resolveApprovalSecretInput(request.data, event.sender)
      );
    },
  );
  registerIpcHandler<[ApprovalRespondRequest], boolean>(
    IPC_CHANNELS.approvalRespond,
    (event, req) => {
      validateId(req.requestId, 'requestId');
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      if (!isApprovalPromptDecision(req.decision)) {
        throw new Error('Invalid approval decision');
      }
      return approvalOwnersFor(event.sender).some((owner) =>
        resolveApproval(req.requestId, req.decision, owner, req),
      );
    },
  );

  registerIpcHandler<[ApprovalDismissRequest], boolean>(
    IPC_CHANNELS.approvalDismiss,
    (event, req) => {
      validateId(req.requestId, 'requestId');
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      return approvalOwnersFor(event.sender).some((owner) =>
        resolveApproval(
          req.requestId,
          {
            behavior: 'deny',
            scope: 'once',
          },
          owner,
          req,
        ),
      );
    },
  );

  registerIpcHandler<[], ApprovalRequestEvent[]>(
    IPC_CHANNELS.approvalPendingRequests,
    (event) =>
      approvalOwnersFor(event.sender).flatMap((owner) =>
        pendingApprovalRequests(owner),
      ),
  );

  registerIpcHandler<[ApprovalModeSetRequest], void>(
    IPC_CHANNELS.approvalModeSet,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      // `mode` now reaches durable GLOBAL policy through the sticky-default
      // write-back (CAN-3055), and `normalizeApprovalDefaults` falls back per
      // key to the Full Access product default rather than to the previously
      // persisted value — so an unvalidated mode would silently escalate a
      // user's persisted Ask instead of being confined to one tab.
      if (!isApprovalMode(req.mode)) {
        throw new Error(`Invalid approval mode: ${String(req.mode)}`);
      }
      if (!approvalModeSetter) {
        return;
      }
      await approvalModeSetter(req);
    },
  );

  registerIpcHandler<[ApprovalResolvedDefaultRequest], ApprovalMode>(
    IPC_CHANNELS.approvalResolvedDefault,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      if (req.worktreeId) {
        validateId(req.worktreeId, 'worktreeId');
      }
      const resolvedProjectId = resolveApprovalProjectId(
        req.projectId,
        req.worktreeId,
      );
      if (!resolvedProjectId) {
        // Unresolvable target is a read failure, not a user default.
        return UNRESOLVABLE_TARGET_APPROVAL_MODE;
      }
      const surface = surfaceForChat(resolvedProjectId);
      const [workspaceApprovals, manifest, approvalPreferences] =
        await Promise.all([
          readWorkspaceApprovals(resolvedProjectId),
          readWorkspaceApprovalsManifest(resolvedProjectId),
          readApprovalPreferencesForSurface(surface),
        ]);
      return resolveApprovalMode({
        workspaceDefault: workspaceApprovals.defaultMode,
        canopyJsonDefault: manifest.defaultMode,
        surface,
        defaults: approvalPreferences.defaults,
      });
    },
  );

  registerIpcHandler<[ApprovalRulesListRequest], ApprovalRulesListResponse>(
    IPC_CHANNELS.approvalRulesList,
    async (_event, req) => {
      const [project, manifest, preferences] = await Promise.all([
        req.workspaceId
          ? readWorkspaceApprovals(requireWorkspaceId(req.workspaceId))
          : Promise.resolve(null),
        req.workspaceId
          ? readWorkspaceApprovalsManifest(requireWorkspaceId(req.workspaceId))
          : Promise.resolve(null),
        readPreferencesFile(),
      ]);
      return {
        project: project
          ? [
              ...project.rules,
              ...(manifest?.rules.filter((rule) => rule.behavior === 'deny') ??
                []),
            ]
          : [],
        global: preferences.globalApprovalRules,
      };
    },
  );

  registerIpcHandler<[ApprovalRuleAddRequest], void>(
    IPC_CHANNELS.approvalRuleAdd,
    async (_event, req) => {
      validateId(req.rule.id, 'rule.id');
      if (req.scope === 'project') {
        const workspaceId = requireWorkspaceId(req.workspaceId);
        await addWorkspaceApprovalRule(workspaceId, req.rule);
        return;
      }
      await updatePreferencesFile((existing) => ({
        globalApprovalRules: [...existing.globalApprovalRules, req.rule],
      }));
      markGlobalApprovalRulesChanged();
    },
  );

  registerIpcHandler<[ApprovalRuleRemoveRequest], void>(
    IPC_CHANNELS.approvalRuleRemove,
    async (_event, req) => {
      validateId(req.ruleId, 'ruleId');
      if (req.scope === 'project') {
        const workspaceId = requireWorkspaceId(req.workspaceId);
        await removeWorkspaceApprovalRule(workspaceId, req.ruleId);
        return;
      }
      await updatePreferencesFile((existing) => ({
        globalApprovalRules: existing.globalApprovalRules.filter(
          (rule) => rule.id !== req.ruleId,
        ),
      }));
      markGlobalApprovalRulesChanged();
    },
  );
}
