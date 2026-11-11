import { runIdempotentWrite } from '../action-support';
import type { BotAction } from '../families/bots/actions';
import type { ProjectAction } from '../families/projects/actions';
import type { ProjectReceiptAddress } from '../families/projects/receipts';
import { AgentPortError } from '../port/environment-port';
import type {
  AgentProjectOwner,
  PipelineTrustedCaller,
} from '../port/project-bot-port';
import { createInMemoryAgentActionReceipts } from '../receipts';
import type { AgentActionToolResult } from '../tools/definition';
import { at, check, checkEqual, checkSubset, stringAt } from './assert';
import type { AgentConformanceTestApi } from './suite';

/**
 * The world a pipeline's project writes run in. IDs are lowercase UUIDs, so
 * a host can seed them into stores that only take UUIDs.
 */
export interface ProjectWriteConformanceWorld {
  /** The run's owner; `projects.cowork` and `projects.code` have it. */
  readonly owner: AgentProjectOwner;
  readonly projects: {
    readonly cowork: string;
    readonly code: string;
    /** Visible to the run's principal, but saved under another owner. */
    readonly otherOwner: string;
    /** Not visible to the run's principal at all. */
    readonly missing: string;
  };
  /**
   * Tasks of the Cowork project; a task's root chat shares its ID. The
   * promoted task's former root was closed, so a later chat became its root
   * and the archived former root lists first.
   */
  readonly tasks: {
    readonly live: string;
    readonly archived: string;
    readonly promoted: string;
  };
  /** The promoted task's archived former root. */
  readonly promotedFormerRoot: string;
  /** A chat of the live task that started the run, for agent-originated runs. */
  readonly originChat: string;
  /** A chat of the live task whose turn is running, so a send queues. */
  readonly busyChat: string;
  /** A task of the other owner's project. */
  readonly otherOwnerTask: string;
}

export const PROJECT_WRITE_CONFORMANCE_WORLD: ProjectWriteConformanceWorld = {
  owner: {
    kind: 'organization',
    organizationId: '6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f',
  },
  projects: {
    cowork: '0b6c5a1e-2d3f-4a8b-9c1d-2e3f4a5b6c7d',
    code: '1c7d6b2f-3e4a-4b9c-8d2e-3f4a5b6c7d8e',
    otherOwner: '2d8e7c3a-4f5b-4cad-9e3f-4a5b6c7d8e9f',
    missing: '3e9f8d4b-5a6c-4dbe-8f4a-5b6c7d8e9fa0',
  },
  tasks: {
    live: '4fa09e5c-6b7d-4ecf-9a5b-6c7d8e9fa0b1',
    archived: '50b1af6d-7c8e-4fd0-8b6c-7d8e9fa0b1c2',
    promoted: 'd8394c75-f406-4578-8de4-f5a6b7c8d9e0',
  },
  promotedFormerRoot: 'e94a5d86-0517-4689-9ef5-a6b7c8d9e0f1',
  originChat: 'c7283b64-e3f5-4467-9cd3-e4f5a6b7c8d9',
  busyChat: 'a5061f42-c1d3-4245-9ab1-c2d3e4f5a6b7',
  otherOwnerTask: '61c2b07e-8d9f-4e01-9c7d-8e9fa0b1c2d3',
};

/** The planned task IDs the suite pins, one per creation. */
const PLANNED = [
  '72d3c18f-9ea0-4f12-8d8e-9fa0b1c2d3e4',
  '83e4d290-afb1-4023-9e9f-a0b1c2d3e4f5',
  '94f5e3a1-b0c2-4134-8fa0-b1c2d3e4f5a6',
] as const;

/** One host step's call: its key and, for a task creation, its planned task. */
export interface ProjectWriteConformanceStep {
  readonly idempotencyKey: string;
  readonly plannedTaskId?: string;
  /** Overrides of the run's trusted caller, such as its origin agent. */
  readonly caller?: Partial<PipelineTrustedCaller>;
}

export interface ProjectWriteConformanceHost {
  /**
   * The project types this host serves to pipelines; the suite expects
   * every other project action to answer `unsupported_action`.
   */
  readonly supports: readonly ProjectAction['type'][];
  /** Runs one host step's write, behind the host's durable receipts. */
  dispatch(
    action: ProjectAction | BotAction,
    step: ProjectWriteConformanceStep,
  ): Promise<AgentActionToolResult>;
  /** Every chat that exists now, for checking a write's effects. */
  chats(): Promise<
    readonly { projectId: string; taskId: string; chatId: string }[]
  >;
  /**
   * Makes the next chat creation fail after the chat exists, as a
   * provisioning failure after Core made its session does. Optional.
   */
  failNextCreateAfterEffect?(): void;
  /**
   * Every message sent so far, with the sender the target chat shows for
   * it (the shared `ChatAgentSentInfo` sender), for checking attribution.
   */
  messages(): Promise<
    readonly { chatId: string; text: string; sender: unknown }[]
  >;
  /**
   * Whether the target's session can take a queued input into its running
   * turn. A host that cannot answers `missing_capability` for a steer the run
   * may make, and the input stays queued.
   */
  readonly steersQueuedInput: boolean;
  /**
   * Makes the next accepted send fail as an unknown outcome after the
   * target accepted it, as a lost response does. Optional.
   */
  loseNextSendResponse?(): void;
  /**
   * Makes the target definitely refuse the next message, before accepting
   * it. Optional.
   */
  refuseNextSend?(): void;
}

export type MakeProjectWriteConformanceHost = (
  world: ProjectWriteConformanceWorld,
) => ProjectWriteConformanceHost | Promise<ProjectWriteConformanceHost>;

const CALLER: Omit<PipelineTrustedCaller, 'owner'> = {
  executionId: 'conformance-execution',
  pipelineId: 'conformance-pipeline',
  stepId: 'conformance-step',
};

/** The sender a run's message shows: its step, never its inputs. */
const RUN_SENDER = {
  kind: 'pipeline',
  executionId: CALLER.executionId,
  pipelineId: CALLER.pipelineId,
  stepId: CALLER.stepId,
};

function parse(result: AgentActionToolResult): unknown {
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`Unreadable result: ${result.text}`);
  }
}

function checkCode(
  result: AgentActionToolResult,
  code: string,
  label: string,
): unknown {
  const json = parse(result);
  check(at(json, 'ok') === false, `${label} is refused`);
  checkEqual(at(json, 'error', 'code'), code, `${label} error code`);
  check(result.isError === true, `${label} is an error result`);
  return json;
}

/** A project chat creation's receipt, as the suite compares it. */
interface CreatedProjectChat {
  address: ProjectReceiptAddress;
  taskCreated: boolean;
  chatCreated: boolean;
}

function checkReceipt(
  result: AgentActionToolResult,
  label: string,
): CreatedProjectChat {
  const json = parse(result);
  check(at(json, 'ok') === true, `${label} succeeds: ${JSON.stringify(json)}`);
  const projectId = stringAt(json, 'result', 'address', 'projectId');
  const taskId = stringAt(json, 'result', 'address', 'taskId');
  const chatId = stringAt(json, 'result', 'address', 'chatId');
  const taskCreated = at(json, 'result', 'taskCreated');
  const chatCreated = at(json, 'result', 'chatCreated');
  check(
    projectId !== undefined &&
      taskId !== undefined &&
      chatId !== undefined &&
      typeof taskCreated === 'boolean' &&
      typeof chatCreated === 'boolean',
    `${label} answers a created-chat receipt`,
  );
  return {
    address: {
      projectId: projectId ?? '',
      taskId: taskId ?? '',
      chatId: chatId ?? '',
    },
    taskCreated: taskCreated === true,
    chatCreated: chatCreated === true,
  };
}

/**
 * The explicit-target project writes a pipeline host step makes through a
 * host's project port, bound to a trusted pipeline caller: owner rules,
 * replay and key reuse under the step's key, the Cowork-only task creation
 * with its planned task ID, and refusals of what the host does not serve.
 */
export function runProjectWriteConformance(
  t: AgentConformanceTestApi,
  makeHost: MakeProjectWriteConformanceHost,
): void {
  const world = PROJECT_WRITE_CONFORMANCE_WORLD;
  const { cowork, code, otherOwner, missing } = world.projects;

  t.describe('pipeline project writes', () => {
    t.it(
      'creates a Cowork task under its planned ID and replays it by the step key',
      async () => {
        const host = await makeHost(world);
        if (!host.supports.includes('projects.create_task')) return;
        const action: ProjectAction = {
          type: 'projects.create_task',
          projectId: cowork,
          title: 'Nightly triage',
        };
        const step = { idempotencyKey: 'step-1', plannedTaskId: PLANNED[0] };
        const before = (await host.chats()).length;
        const first = await host.dispatch(action, step);
        checkEqual(
          checkReceipt(first, 'projects.create_task'),
          {
            address: {
              projectId: cowork,
              taskId: PLANNED[0],
              chatId: PLANNED[0],
            },
            taskCreated: true,
            chatCreated: true,
          },
          'created task receipt',
        );
        const replay = await host.dispatch(action, step);
        checkEqual(replay, first, 'a retry under the step key replays');
        checkEqual(
          (await host.chats()).length,
          before + 1,
          'the task and its founding chat are created once',
        );
        checkCode(
          await host.dispatch({ ...action, title: 'Other' }, step),
          'idempotency_conflict',
          'the step key reused for another request',
        );
        checkCode(
          await host.dispatch(action, { idempotencyKey: 'step-2' }),
          'validation_failed',
          'a task creation without its planned ID',
        );
        checkCode(
          await host.dispatch(
            { type: 'projects.create_task', projectId: code },
            { idempotencyKey: 'step-3', plannedTaskId: PLANNED[1] },
          ),
          'unsupported_action',
          'a task creation in a code project',
        );
        checkEqual(
          (await host.chats()).length,
          before + 1,
          'refused creations create nothing',
        );
      },
    );

    t.it('reads another owner’s project exactly as a missing one', async () => {
      const host = await makeHost(world);
      const creations = (
        ['projects.create_task', 'projects.create_task_chat'] as const
      ).filter((type) => host.supports.includes(type));
      for (const type of creations) {
        const refusal = (
          projectId: string,
          key: string,
        ): Promise<AgentActionToolResult> =>
          host.dispatch(
            type === 'projects.create_task'
              ? { type, projectId }
              : { type, projectId, taskId: world.otherOwnerTask },
            { idempotencyKey: key, plannedTaskId: PLANNED[2] },
          );
        const other = checkCode(
          await refusal(otherOwner, `${type}-other`),
          'not_found',
          `${type} in another owner's project`,
        );
        const absent = checkCode(
          await refusal(missing, `${type}-missing`),
          'not_found',
          `${type} in a missing project`,
        );
        checkEqual(
          at(other, 'error'),
          at(absent, 'error'),
          `${type} answers another owner's project as a missing one`,
        );
      }
      checkEqual(
        (await host.chats()).filter((chat) => chat.projectId === otherOwner)
          .length,
        1,
        "another owner's project gains no chat",
      );
    });

    t.it('creates a chat in a live task and replays it', async () => {
      const host = await makeHost(world);
      if (!host.supports.includes('projects.create_task_chat')) return;
      const action: ProjectAction = {
        type: 'projects.create_task_chat',
        projectId: cowork,
        taskId: world.tasks.live,
      };
      const step = { idempotencyKey: 'chat-step-1' };
      const first = await host.dispatch(action, step);
      const receipt = checkReceipt(first, 'projects.create_task_chat');
      checkEqual(
        {
          projectId: receipt.address.projectId,
          taskId: receipt.address.taskId,
          taskCreated: receipt.taskCreated,
          chatCreated: receipt.chatCreated,
        },
        {
          projectId: cowork,
          taskId: world.tasks.live,
          taskCreated: false,
          chatCreated: true,
        },
        'created chat receipt',
      );
      check(
        receipt.address.chatId !== world.tasks.live,
        'the new chat is not the task root',
      );
      checkEqual(
        await host.dispatch(action, step),
        first,
        'a retry under the step key replays',
      );
      const inTask = (await host.chats()).filter(
        (chat) => chat.taskId === world.tasks.live,
      );
      checkEqual(
        inTask.map((chat) => chat.chatId).sort(),
        [
          world.tasks.live,
          world.originChat,
          world.busyChat,
          receipt.address.chatId,
        ].sort(),
        'the chat is created once, in its task',
      );
      checkSubset(
        checkReceipt(
          await host.dispatch(
            { ...action, taskId: world.tasks.promoted },
            { idempotencyKey: 'chat-promoted' },
          ),
          'a chat in a task whose root was promoted',
        ).address,
        { projectId: cowork, taskId: world.tasks.promoted },
        'the chat joins the promoted task',
      );
      for (const [taskId, label] of [
        [world.tasks.archived, 'an archived task'],
        ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'a missing task'],
      ] as const)
        checkCode(
          await host.dispatch(
            { ...action, taskId },
            { idempotencyKey: `chat-${taskId}` },
          ),
          'not_found',
          `a chat in ${label}`,
        );
    });

    t.it('sends as the run’s step and replays it by the step key', async () => {
      const host = await makeHost(world);
      if (!host.supports.includes('projects.send_message')) return;
      const address = {
        projectId: cowork,
        taskId: world.tasks.live,
        chatId: world.tasks.live,
      };
      const action: ProjectAction = {
        type: 'projects.send_message',
        ...address,
        text: 'Summarize the open issues.',
      };
      const step = { idempotencyKey: 'send-step-1' };
      const first = await host.dispatch(action, step);
      const json = parse(first);
      check(at(json, 'ok') === true, `send succeeds: ${first.text}`);
      checkEqual(at(json, 'result', 'address'), address, 'send address');
      checkEqual(
        at(json, 'result', 'disposition'),
        'started',
        'a send to an idle chat starts',
      );
      check(
        typeof at(json, 'result', 'messageId') === 'string',
        'a started send names its message',
      );
      checkEqual(
        await host.dispatch(action, step),
        first,
        'a retry under the step key replays',
      );
      checkEqual(
        (await host.messages()).map(({ chatId, text, sender }) => ({
          chatId,
          text,
          sender,
        })),
        [{ chatId: address.chatId, text: action.text, sender: RUN_SENDER }],
        'the message is sent once, attributed to the run',
      );
      checkCode(
        await host.dispatch({ ...action, text: 'Other' }, step),
        'idempotency_conflict',
        'the step key reused for another message',
      );
      const other = checkCode(
        await host.dispatch(
          {
            ...action,
            projectId: otherOwner,
            taskId: world.otherOwnerTask,
            chatId: world.otherOwnerTask,
          },
          { idempotencyKey: 'send-other' },
        ),
        'not_found',
        "a send to another owner's project",
      );
      const absent = checkCode(
        await host.dispatch(
          { ...action, projectId: missing },
          { idempotencyKey: 'send-missing' },
        ),
        'not_found',
        'a send to a missing project',
      );
      checkEqual(
        at(other, 'error'),
        at(absent, 'error'),
        "a send answers another owner's project as a missing one",
      );
      checkCode(
        await host.dispatch(
          { ...action, chatId: world.otherOwnerTask },
          { idempotencyKey: 'send-outside' },
        ),
        'not_found',
        'a send to a chat outside the task',
      );
      checkCode(
        await host.dispatch(
          { ...action, watchers: [{ label: 'Done' }] },
          { idempotencyKey: 'send-watchers' },
        ),
        'unsupported_action',
        'a send with inline watchers',
      );
      checkEqual(
        (await host.messages()).length,
        1,
        'refused sends send nothing',
      );
    });

    t.it(
      'queues behind a running turn and steers only the run’s own input',
      async () => {
        const host = await makeHost(world);
        if (
          !host.supports.includes('projects.send_message') ||
          !host.supports.includes('projects.steer_queued_message')
        )
          return;
        const address = {
          projectId: cowork,
          taskId: world.tasks.live,
          chatId: world.busyChat,
        };
        const send: ProjectAction = {
          type: 'projects.send_message',
          ...address,
          text: 'Next.',
        };
        // A lost response leaves the step uncertain; its retry still learns
        // that the input is queued, so the run can name it.
        if (host.loseNextSendResponse) {
          host.loseNextSendResponse();
          const lost = await host.dispatch(send, {
            idempotencyKey: 'queue-step',
          });
          const json = parse(lost);
          check(
            at(json, 'ok') === false &&
              ['surface_unavailable', 'timeout'].includes(
                stringAt(json, 'error', 'code') ?? '',
              ) &&
              at(json, 'error', 'retryable') === true,
            `a send whose response was lost is a retryable unknown outcome: ${lost.text}`,
          );
        }
        const sent = parse(
          await host.dispatch(send, { idempotencyKey: 'queue-step' }),
        );
        checkEqual(
          at(sent, 'result', 'disposition'),
          'queued',
          'a send to a busy chat queues',
        );
        const queuedMessageId = stringAt(sent, 'result', 'queuedMessageId');
        check(queuedMessageId !== undefined, 'a queued send names its input');
        const steer: ProjectAction = {
          type: 'projects.steer_queued_message',
          ...address,
          queuedMessageId: queuedMessageId ?? '',
        };
        checkCode(
          await host.dispatch(steer, {
            idempotencyKey: 'steer-other-run',
            caller: { executionId: 'other-execution' },
          }),
          'not_found',
          "another run steering this run's input",
        );
        checkCode(
          await host.dispatch(
            {
              ...steer,
              queuedMessageId: 'b6172a53-d2e4-4356-8bc2-d3e4f5a6b7c8',
            },
            { idempotencyKey: 'steer-unknown' },
          ),
          'not_found',
          'steering an input the run did not queue',
        );
        const steered = await host.dispatch(steer, {
          idempotencyKey: 'steer-step',
        });
        if (!host.steersQueuedInput) {
          checkCode(
            steered,
            'missing_capability',
            "steering the run's own input where the session cannot steer",
          );
          return;
        }
        const json = parse(steered);
        check(at(json, 'ok') === true, `steer succeeds: ${steered.text}`);
        checkSubset(
          at(json, 'result'),
          { address, queuedMessageId, disposition: 'steered' },
          'steered receipt',
        );
        checkEqual(
          await host.dispatch(steer, { idempotencyKey: 'steer-step' }),
          steered,
          'a retry under the step key replays',
        );
      },
    );

    t.it('sends a created task’s first message as the run', async () => {
      const host = await makeHost(world);
      if (
        !host.supports.includes('projects.create_task') ||
        !host.supports.includes('projects.send_message')
      )
        return;
      const created = parse(
        await host.dispatch(
          {
            type: 'projects.create_task',
            projectId: cowork,
            initialMessage: 'Start the triage.',
          },
          { idempotencyKey: 'create-with-message', plannedTaskId: PLANNED[1] },
        ),
      );
      checkSubset(
        at(created, 'result'),
        {
          address: {
            projectId: cowork,
            taskId: PLANNED[1],
            chatId: PLANNED[1],
          },
          input: {
            address: {
              projectId: cowork,
              taskId: PLANNED[1],
              chatId: PLANNED[1],
            },
            disposition: 'started',
          },
        },
        'created task receipt with its first message',
      );
      checkEqual(
        await host.messages(),
        [{ chatId: PLANNED[1], text: 'Start the triage.', sender: RUN_SENDER }],
        'the first message is attributed to the run',
      );
    });

    t.it(
      'keeps a creation that failed after it took effect for the same request only',
      async () => {
        const host = await makeHost(world);
        if (
          !host.failNextCreateAfterEffect ||
          !host.supports.includes('projects.create_task')
        )
          return;
        const action: ProjectAction = {
          type: 'projects.create_task',
          projectId: cowork,
        };
        const step = {
          idempotencyKey: 'lost-create',
          plannedTaskId: PLANNED[0],
        };
        const before = (await host.chats()).length;
        host.failNextCreateAfterEffect();
        const lost = parse(await host.dispatch(action, step));
        check(
          at(lost, 'ok') === false &&
            ['surface_unavailable', 'timeout'].includes(
              stringAt(lost, 'error', 'code') ?? '',
            ) &&
            at(lost, 'error', 'retryable') === true,
          `a creation that failed after it took effect is a retryable unknown outcome: ${JSON.stringify(lost)}`,
        );
        checkCode(
          await host.dispatch(action, {
            ...step,
            plannedTaskId: PLANNED[1],
          }),
          'idempotency_conflict',
          'the uncertain step key reused for another task',
        );
        checkReceipt(
          await host.dispatch(action, step),
          'the same request retried',
        );
        checkEqual(
          (await host.chats()).length,
          before + 1,
          'the task is created once',
        );
      },
    );

    t.it(
      'records a created task whose first message was refused under its key',
      async () => {
        const host = await makeHost(world);
        if (
          !host.refuseNextSend ||
          !host.supports.includes('projects.create_task') ||
          !host.supports.includes('projects.send_message')
        )
          return;
        const action: ProjectAction = {
          type: 'projects.create_task',
          projectId: cowork,
          initialMessage: 'Start the triage.',
        };
        const step = {
          idempotencyKey: 'refused-first',
          plannedTaskId: PLANNED[2],
        };
        const before = (await host.chats()).length;
        host.refuseNextSend();
        const refused = await host.dispatch(action, step);
        check(
          at(parse(refused), 'ok') === false,
          `a created task's refused first message fails the step: ${refused.text}`,
        );
        checkEqual(
          await host.dispatch(action, step),
          refused,
          'a retry under the step key replays the refusal',
        );
        checkCode(
          await host.dispatch(action, { ...step, plannedTaskId: PLANNED[0] }),
          'idempotency_conflict',
          'the step key reused for another task',
        );
        checkEqual(
          (await host.chats()).length,
          before + 1,
          'the task is created once',
        );
        checkEqual(
          await host.messages(),
          [],
          'the refused message is not sent',
        );
      },
    );

    t.it(
      'refuses an origin agent outside the run owner, and what the host does not serve',
      async () => {
        const host = await makeHost(world);
        if (host.supports.includes('projects.create_task_chat'))
          checkReceipt(
            await host.dispatch(
              {
                type: 'projects.create_task_chat',
                projectId: cowork,
                taskId: world.tasks.live,
              },
              {
                idempotencyKey: 'origin-own-step',
                caller: {
                  agentOrigin: {
                    projectId: cowork,
                    worktreeId: world.tasks.live,
                    chatId: world.originChat,
                  },
                },
              },
            ),
            'a run started by an agent chat of the run owner',
          );
        const before = (await host.chats()).length;
        if (host.supports.includes('projects.create_task_chat'))
          checkCode(
            await host.dispatch(
              {
                type: 'projects.create_task_chat',
                projectId: cowork,
                taskId: world.tasks.live,
              },
              {
                idempotencyKey: 'origin-step',
                caller: {
                  agentOrigin: {
                    projectId: otherOwner,
                    worktreeId: world.otherOwnerTask,
                    chatId: world.otherOwnerTask,
                  },
                },
              },
            ),
            'authorization_conflict',
            "an origin agent in another owner's project",
          );
        const unserved: (ProjectAction | BotAction)[] = [
          { type: 'bots.create_task', botId: 'conformance-bot' },
          {
            type: 'bots.send_message',
            botId: 'conformance-bot',
            taskId: world.tasks.live,
            chatId: world.tasks.live,
            text: 'Hello',
          },
        ];
        const projectActions: ProjectAction[] = [
          { type: 'projects.create_task', projectId: cowork },
          {
            type: 'projects.create_task_chat',
            projectId: cowork,
            taskId: world.tasks.live,
          },
          {
            type: 'projects.send_message',
            projectId: cowork,
            taskId: world.tasks.live,
            chatId: world.tasks.live,
            text: 'Hello',
          },
          {
            type: 'projects.steer_queued_message',
            projectId: cowork,
            taskId: world.tasks.live,
            chatId: world.tasks.live,
            queuedMessageId: world.tasks.live,
          },
        ];
        unserved.push(
          ...projectActions.filter(
            (action) => !host.supports.includes(action.type),
          ),
        );
        for (const [index, action] of unserved.entries())
          checkCode(
            await host.dispatch(action, {
              idempotencyKey: `unserved-${String(index)}`,
              plannedTaskId: PLANNED[2],
            }),
            'unsupported_action',
            action.type,
          );
        checkEqual(
          (await host.chats()).length,
          before,
          'refused writes create nothing',
        );
      },
    );
  });
}

/** A refusal after a write took effect, which the reference host records. */
class RecordedRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The in-memory host the package runs the suite against: the shared rules
 * over plain chat and message lists, behind the in-memory receipts.
 */
export function createReferenceProjectWriteHost(
  world: ProjectWriteConformanceWorld,
): ProjectWriteConformanceHost {
  const owners = new Map<string, AgentProjectOwner>([
    [world.projects.cowork, world.owner],
    [world.projects.code, world.owner],
    [world.projects.otherOwner, { kind: 'personal' }],
  ]);
  const kinds = new Map([
    [world.projects.cowork, 'cowork'],
    [world.projects.code, 'git'],
    [world.projects.otherOwner, 'cowork'],
  ]);
  const chat = (
    projectId: string,
    taskId: string,
    chatId: string,
    state: { archived?: boolean; running?: boolean } = {},
  ): {
    projectId: string;
    taskId: string;
    chatId: string;
    archived: boolean;
    running: boolean;
  } => ({
    projectId,
    taskId,
    chatId,
    archived: state.archived === true,
    running: state.running === true,
  });
  const chats = [
    chat(world.projects.cowork, world.tasks.live, world.tasks.live),
    chat(world.projects.cowork, world.tasks.archived, world.tasks.archived, {
      archived: true,
    }),
    chat(world.projects.cowork, world.tasks.live, world.originChat),
    chat(
      world.projects.cowork,
      world.tasks.promoted,
      world.promotedFormerRoot,
      { archived: true },
    ),
    chat(world.projects.cowork, world.tasks.promoted, world.tasks.promoted),
    chat(world.projects.cowork, world.tasks.live, world.busyChat, {
      running: true,
    }),
    chat(world.projects.otherOwner, world.otherOwnerTask, world.otherOwnerTask),
  ];
  const messages: { chatId: string; text: string; sender: unknown }[] = [];
  let refuseSend = false;
  /** Queued inputs by ID, with the run that queued each. */
  const queued = new Map<
    string,
    { executionId: string; address: ProjectReceiptAddress }
  >();
  const receipts = createInMemoryAgentActionReceipts<null>();
  const sameOwner = (a: AgentProjectOwner, b: AgentProjectOwner): boolean =>
    a.kind === 'personal'
      ? b.kind === 'personal'
      : b.kind === 'organization' && a.organizationId === b.organizationId;
  const project = (projectId: string, owner: AgentProjectOwner): string => {
    const saved = owners.get(projectId);
    if (saved === undefined || !sameOwner(saved, owner))
      throw new AgentPortError('not_found', 'The project was not found.');
    return projectId;
  };
  const liveTask = (projectId: string, taskId: string): string => {
    const root = chats.find(
      (entry) =>
        entry.projectId === projectId &&
        entry.chatId === taskId &&
        entry.taskId === taskId &&
        !entry.archived,
    );
    if (root === undefined)
      throw new AgentPortError('not_found', 'The task is not available.');
    return taskId;
  };
  const send = (
    address: ProjectReceiptAddress,
    text: string,
    step: ProjectWriteConformanceStep,
    caller: PipelineTrustedCaller,
  ): Record<string, unknown> => {
    const target = chats.find(
      (entry) =>
        entry.projectId === address.projectId &&
        entry.taskId === address.taskId &&
        entry.chatId === address.chatId,
    );
    if (target === undefined)
      throw new AgentPortError('not_found', 'The chat was not found.');
    if (refuseSend) {
      refuseSend = false;
      throw new AgentPortError(
        'invalid_target',
        'The chat refused the message.',
      );
    }
    messages.push({
      chatId: address.chatId,
      text,
      sender: {
        kind: 'pipeline',
        executionId: caller.executionId,
        pipelineId: caller.pipelineId ?? caller.executionId,
        stepId: caller.stepId,
      },
    });
    const messageId = `message-${step.idempotencyKey}`;
    const base = { address, acceptedAt: 'conformance', watcherReceipts: [] };
    if (!target.running) return { ...base, disposition: 'started', messageId };
    const queuedMessageId = `queued-${step.idempotencyKey}`;
    queued.set(queuedMessageId, { executionId: caller.executionId, address });
    return { ...base, disposition: 'queued', queuedMessageId, messageId };
  };

  const write = (
    action: ProjectAction | BotAction,
    step: ProjectWriteConformanceStep,
    caller: PipelineTrustedCaller,
  ): Record<string, unknown> => {
    if (
      action.type !== 'projects.create_task' &&
      action.type !== 'projects.create_task_chat' &&
      action.type !== 'projects.send_message' &&
      action.type !== 'projects.steer_queued_message'
    )
      throw new AgentPortError('unsupported_action', `${action.type}`);
    if (
      action.type === 'projects.send_message' &&
      (action.watchers?.length ?? 0) > 0
    )
      throw new AgentPortError('unsupported_action', 'No inline watchers.');
    const origin = caller.agentOrigin;
    const originOwner =
      origin === undefined ? undefined : owners.get(origin.projectId);
    if (
      origin !== undefined &&
      (originOwner === undefined ||
        !sameOwner(originOwner, caller.owner) ||
        !chats.some(
          (entry) =>
            entry.projectId === origin.projectId &&
            entry.taskId === origin.worktreeId &&
            entry.chatId === origin.chatId,
        ))
    )
      throw new AgentPortError(
        'authorization_conflict',
        'The agent that started this run could not be verified.',
      );
    const projectId = project(action.projectId, caller.owner);
    if (action.type === 'projects.send_message') {
      const taskId = liveTask(projectId, action.taskId);
      return send(
        { projectId, taskId, chatId: action.chatId },
        action.text,
        step,
        caller,
      );
    }
    if (action.type === 'projects.steer_queued_message') {
      const taskId = liveTask(projectId, action.taskId);
      const entry = queued.get(action.queuedMessageId);
      if (
        entry === undefined ||
        entry.executionId !== caller.executionId ||
        entry.address.projectId !== projectId ||
        entry.address.taskId !== taskId ||
        entry.address.chatId !== action.chatId
      )
        throw new AgentPortError(
          'not_found',
          'The queued message was not found.',
        );
      queued.delete(action.queuedMessageId);
      return {
        address: entry.address,
        queuedMessageId: action.queuedMessageId,
        disposition: 'steered',
        steeredAt: 'conformance',
      };
    }
    let created: CreatedProjectChat;
    if (action.type === 'projects.create_task') {
      if (kinds.get(projectId) !== 'cowork')
        throw new AgentPortError('unsupported_action', 'Code task.');
      if (step.plannedTaskId === undefined)
        throw new AgentPortError('validation_failed', 'No planned task ID.');
      const taskId = step.plannedTaskId;
      chats.push(chat(projectId, taskId, taskId));
      created = {
        address: { projectId, taskId, chatId: taskId },
        taskCreated: true,
        chatCreated: true,
      };
    } else {
      const taskId = liveTask(projectId, action.taskId);
      const chatId = `chat-${step.idempotencyKey}`;
      chats.push(chat(projectId, taskId, chatId));
      created = {
        address: { projectId, taskId, chatId },
        taskCreated: false,
        chatCreated: true,
      };
    }
    if (action.initialMessage === undefined) return { ...created };
    try {
      return {
        ...created,
        input: send(created.address, action.initialMessage, step, caller),
      };
    } catch (error) {
      // The chat exists: the refusal is the step's recorded answer.
      if (!(error instanceof AgentPortError)) throw error;
      throw new RecordedRefusal(error.code, error.message);
    }
  };
  /** The step's response: its result, or a refusal recorded after an effect. */
  const respond = (
    action: ProjectAction | BotAction,
    step: ProjectWriteConformanceStep,
    caller: PipelineTrustedCaller,
  ): AgentActionToolResult => {
    try {
      return {
        text: JSON.stringify({ ok: true, result: write(action, step, caller) }),
      };
    } catch (error) {
      if (!(error instanceof RecordedRefusal)) throw error;
      return {
        text: JSON.stringify({
          ok: false,
          error: { code: error.code, message: error.message },
        }),
        isError: true,
      };
    }
  };

  return {
    supports: [
      'projects.create_task',
      'projects.create_task_chat',
      'projects.send_message',
      'projects.steer_queued_message',
    ],
    dispatch: async (action, step) => {
      const caller = projectWriteConformanceCaller(world, step);
      const call = { actorKey: `pipeline:${caller.executionId}`, host: null };
      try {
        return await runIdempotentWrite({
          receipts,
          limits: null,
          kind: 'chat.create',
          call,
          idempotencyKey: step.idempotencyKey,
          payload: { action, plannedTaskId: step.plannedTaskId },
          prepare: () =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: () => Promise.resolve(respond(action, step, caller)),
            }),
        });
      } catch (error) {
        if (!(error instanceof AgentPortError)) throw error;
        return {
          text: JSON.stringify({
            ok: false,
            error: { code: error.code, message: error.message },
          }),
          isError: true,
        };
      }
    },
    chats: () =>
      Promise.resolve(
        chats.map(({ projectId, taskId, chatId }) => ({
          projectId,
          taskId,
          chatId,
        })),
      ),
    messages: () => Promise.resolve(messages.map((entry) => ({ ...entry }))),
    steersQueuedInput: true,
    refuseNextSend: (): void => {
      refuseSend = true;
    },
  };
}

/** The trusted caller a host builds for a suite step. */
export function projectWriteConformanceCaller(
  world: ProjectWriteConformanceWorld,
  step: ProjectWriteConformanceStep,
): PipelineTrustedCaller {
  return { ...CALLER, owner: world.owner, ...step.caller };
}
