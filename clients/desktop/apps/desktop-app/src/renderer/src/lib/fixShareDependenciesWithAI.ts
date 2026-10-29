import type { CapabilityRepairSubject } from '@canopy/protocol/capability-package-repair';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import type {
  CapabilityPackageRepairBinding,
  CapabilityPackageRepairLaunch,
} from '@canopy/ui-app/sharing';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { CUSTOM_SKILL_SOURCE_ID } from './sharedSkillImport';

/**
 * "Fix it with AI" for a blocked skill or pipeline share (CAN-3488). The
 * shared dialog builds the request and prompt; this module decides which
 * items can be repaired and opens the one chat that repairs them.
 *
 * Custom skills and saved pipelines repair in a new Cowork chat. A project
 * pipeline lives in a worktree checkout, so it repairs in a new chat of that
 * worktree, where the agent's file and pipeline tools resolve against it.
 */

export type ShareRepairChatTarget =
  | { kind: 'cowork' }
  | {
      kind: 'worktree';
      projectId: string;
      worktreeId: string;
      repoId?: string;
    };

export type ShareRepairIneligibleReason =
  | 'read-only-skill'
  | 'bundled-pipeline'
  | 'curated-pipeline'
  | 'shared-pipeline'
  | 'project-source-unavailable';

export type ShareRepairEligibility =
  | {
      status: 'eligible';
      subject: CapabilityRepairSubject;
      chat: ShareRepairChatTarget;
    }
  | { status: 'ineligible'; reason: ShareRepairIneligibleReason };

/** Only custom skills are editable by the skill-update tools. */
export function skillShareRepairEligibility(skill: {
  sourceId: string;
  name: string;
}): ShareRepairEligibility {
  if (skill.sourceId !== CUSTOM_SKILL_SOURCE_ID) {
    return { status: 'ineligible', reason: 'read-only-skill' };
  }
  return {
    status: 'eligible',
    subject: {
      kind: 'skill',
      sourceId: CUSTOM_SKILL_SOURCE_ID,
      skillName: skill.name,
    },
    chat: { kind: 'cowork' },
  };
}

/**
 * Saved pipelines repair in Cowork. A project pipeline needs its owning
 * worktree and its repository-relative file path; without either it is
 * unavailable rather than guessed.
 */
export function pipelineShareRepairEligibility(
  info: Pick<PipelineInfo, 'id' | 'source'>,
  project?: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    relativePath: string | null;
  },
): ShareRepairEligibility {
  switch (info.source) {
    case 'user':
      return {
        status: 'eligible',
        subject: { kind: 'user-pipeline', pipelineId: info.id },
        chat: { kind: 'cowork' },
      };
    case 'project':
      if (!project?.relativePath) {
        return { status: 'ineligible', reason: 'project-source-unavailable' };
      }
      return {
        status: 'eligible',
        subject: {
          kind: 'project-pipeline',
          pipelineId: info.id,
          worktreeId: project.worktreeId,
          relativePath: project.relativePath,
          ...(project.repoId ? { repoId: project.repoId } : {}),
        },
        chat: {
          kind: 'worktree',
          projectId: project.projectId,
          worktreeId: project.worktreeId,
          ...(project.repoId ? { repoId: project.repoId } : {}),
        },
      };
    case 'bundled':
      return { status: 'ineligible', reason: 'bundled-pipeline' };
    case 'curated':
      return { status: 'ineligible', reason: 'curated-pipeline' };
    case 'shared':
      return { status: 'ineligible', reason: 'shared-pipeline' };
  }
}

/**
 * A chat this module created whose follow-up (send or navigation) failed.
 * Retrying recovers it instead of creating another chat.
 */
type RepairChatRecord =
  | {
      kind: 'cowork';
      projectId: string;
      worktreeId: string;
      chatId: string;
      messageId: string;
      prompt: string;
      sent: boolean;
    }
  | {
      kind: 'worktree';
      projectId: string;
      worktreeId: string;
      chatId: string;
      messageId: string;
      prompt: string;
      sent: boolean;
    };

const inFlight = new Map<string, { prompt: string; promise: Promise<void> }>();
const recoverable = new Map<string, RepairChatRecord>();

function launchKey(
  chat: ShareRepairChatTarget,
  subject: CapabilityRepairSubject,
): string {
  return JSON.stringify([chat, subject]);
}

function worktreeChatExists(record: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): boolean {
  const chat =
    useChatStore.getState().worktreeChats[
      `${record.projectId}/${record.worktreeId}`
    ];
  return chat?.tabs.some((tab) => tab.id === record.chatId) ?? false;
}

async function openWorktreeRepairChat(
  key: string,
  target: Extract<ShareRepairChatTarget, { kind: 'worktree' }>,
  prompt: string,
): Promise<void> {
  const { projectId, worktreeId } = target;
  const cwd = await window.api.getWorktreePath({
    projectId,
    worktreeId,
    ...(target.repoId ? { repoId: target.repoId } : {}),
  });
  if (!cwd) throw new Error('The repair worktree is unavailable.');
  const previous = recoverable.get(key);
  let record =
    previous?.kind === 'worktree' &&
    previous.projectId === projectId &&
    previous.worktreeId === worktreeId &&
    worktreeChatExists(previous)
      ? previous
      : null;
  const chatStore = useChatStore.getState();
  chatStore.selectWorktree(projectId, worktreeId);
  if (record === null) {
    chatStore.createTab({
      projectId,
      worktreeId,
      ...(target.repoId ? { selectedRepoId: target.repoId } : {}),
    });
    // Capture the optimistic id before a hydration can swap the active tab.
    const chatId =
      useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`]
        ?.activeTabId;
    if (!chatId) throw new Error('Could not create the repair chat.');
    record = {
      kind: 'worktree',
      projectId,
      worktreeId,
      chatId,
      messageId: crypto.randomUUID(),
      prompt,
      sent: false,
    };
    recoverable.set(key, record);
  }
  await useChatStore
    .getState()
    .ensureWorktreeHasChatTab({ projectId, worktreeId });
  useChatStore.getState().switchTab(record.chatId);
  if (record.prompt !== prompt) {
    record.prompt = prompt;
    record.messageId = crypto.randomUUID();
    record.sent = false;
  }
  if (!record.sent) {
    await useChatStore.getState().sendMessage(
      prompt,
      undefined,
      {
        projectId,
        worktreeId,
        chatId: record.chatId,
      },
      undefined,
      {
        throwOnDispatchFailure: true,
        userMessageId: record.messageId,
        onDispatchAccepted: () => {
          record.sent = true;
        },
      },
    );
    if (!record.sent) throw new Error('The repair message was not accepted.');
  }
  useNavigationStore.getState().navigate('main');
}

async function openCoworkRepairChat(
  key: string,
  prompt: string,
  subject: CapabilityRepairSubject,
): Promise<void> {
  const previous = recoverable.get(key);
  if (previous?.kind === 'cowork') {
    const store = useStandaloneChatStore.getState();
    if (
      store.activeChatProjectId !== previous.projectId &&
      !(await store.switchChatProject(previous.projectId))
    )
      throw new Error('Could not recover the repair project.');
    if (!(await useStandaloneChatStore.getState().selectChat(previous.chatId)))
      throw new Error('The repair chat is unavailable.');
    await useChatStore.getState().ensureWorktreeHasChatTab({
      projectId: previous.projectId,
      worktreeId: previous.worktreeId,
    });
    if (previous.prompt !== prompt) {
      previous.prompt = prompt;
      previous.messageId = crypto.randomUUID();
      previous.sent = false;
    }
    if (!previous.sent) {
      await useChatStore.getState().sendMessage(
        prompt,
        undefined,
        {
          projectId: previous.projectId,
          worktreeId: previous.worktreeId,
          chatId: previous.chatId,
        },
        undefined,
        {
          throwOnDispatchFailure: true,
          userMessageId: previous.messageId,
          onDispatchAccepted: () => {
            previous.sent = true;
          },
        },
      );
      if (!previous.sent)
        throw new Error('The repair message was not accepted.');
    }
  } else {
    const messageId = crypto.randomUUID();
    await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
      message: prompt,
      ...(subject.kind === 'skill'
        ? {
            config: {
              pluginSelections: {
                collectionIds: [],
                skillRefs: [
                  { sourceId: subject.sourceId, skillName: subject.skillName },
                ],
                pluginRefs: [],
              },
            },
          }
        : {}),
      recovery: {
        userMessageId: messageId,
        onCreated: (target) =>
          recoverable.set(key, {
            ...target,
            kind: 'cowork',
            messageId,
            prompt,
            sent: false,
          }),
        onSubmitted: () => {
          const record = recoverable.get(key);
          if (record) record.sent = true;
        },
      },
    });
  }
  useNavigationStore.getState().navigate('chat');
}

/**
 * Opens one repair chat and submits the prompt. Concurrent calls for the same
 * subject share one launch; a retry after a partial failure reuses the chat
 * that was already created. Rejects when the chat could not be started.
 */
export function openShareRepairChat(
  chat: ShareRepairChatTarget,
  launch: CapabilityPackageRepairLaunch,
): Promise<void> {
  const key = launchKey(chat, launch.request.subject);
  const pending = inFlight.get(key);
  if (pending)
    return pending.prompt === launch.prompt
      ? pending.promise
      : Promise.reject(
          new Error('A repair chat with different context is still opening.'),
        );
  const run = (async (): Promise<void> => {
    try {
      if (chat.kind === 'worktree') {
        await openWorktreeRepairChat(key, chat, launch.prompt);
      } else {
        await openCoworkRepairChat(key, launch.prompt, launch.request.subject);
      }
      recoverable.delete(key);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, { prompt: launch.prompt, promise: run });
  return run;
}

/** The dialog binding for an eligible item, or `undefined` to hide the button. */
export function shareRepairBinding(
  eligibility: ShareRepairEligibility,
  displayName: string,
): CapabilityPackageRepairBinding | undefined {
  if (eligibility.status !== 'eligible') return undefined;
  const { subject, chat } = eligibility;
  return {
    subject,
    displayName,
    ...(subject.kind === 'project-pipeline'
      ? {
          context: {
            worktree: {
              worktreeId: subject.worktreeId,
              ...(subject.repoId ? { repoId: subject.repoId } : {}),
            },
          },
        }
      : {}),
    open: (launch) => openShareRepairChat(chat, launch),
  };
}

/** Test seam: forget launches between cases. */
export function resetShareRepairChatsForTests(): void {
  inFlight.clear();
  recoverable.clear();
}
