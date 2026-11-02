/** @jest-environment jsdom */
/**
 * CAN-4051: the desktop half of the subagent parity golden. Each recorded
 * fixture runs through the real desktop path (the chat store's event
 * reducer and activity dispatch, the Subagents tree store, the shared
 * transcript builder and the background task adapter) and must equal the
 * committed golden, which the cloud half checks against too.
 */
// eslint-disable-next-line no-restricted-imports
import { writeFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSubagentChatTranscript } from '@canopy/agent-transcript';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import { CLAUDE_PARITY_MODEL } from '@canopy/agent-transcript/lib/subagent-tree/__tests__/parity/claude-scenario';
import {
  PARITY_FIXTURES,
  type ParityFixture,
} from '@canopy/agent-transcript/lib/subagent-tree/__tests__/parity/fixtures';
import {
  canonicalBackgroundTasks,
  canonicalDesktopTranscript,
  canonicalTree,
  toJson,
  toolLabelText,
  type DescribeTool,
} from '@canopy/agent-transcript/lib/subagent-tree/__tests__/parity/canonical';
import {
  expectedFor,
  goldenWith,
  getAt,
  type Json,
} from '@canopy/agent-transcript/lib/subagent-tree/__tests__/parity/golden';
import GOLDEN_FILE from '@canopy/agent-transcript/lib/subagent-tree/__tests__/parity/golden.json';
import {
  PARITY_PROJECT_ID,
  PARITY_WORKTREE_ID,
  type DesktopRecordedEvent,
} from '@canopy/agent-transcript/lib/subagent-tree/__tests__/parity/recording';
import {
  getToolDisplayInfo,
  getToolFamilyFromName,
} from '@canopy/ui-shared/components';
import { backgroundProcessToTask } from '@/lib/background-tasks';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { dispatchActivityEvent } from '@/stores/chat/activity-dispatch';
import { applyTabEvent } from '@/stores/chat/event-transforms';
import { hydratedKeys } from '@/stores/chat/hydration';
import { resetSubagentTreeStoreForTests } from '../subagent-tree-store';
import { useSubagentTree, type SubagentTreeQuery } from '../useSubagentTree';
import type { SubagentHostScope } from '../subagent-scope';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const GOLDEN: Json = toJson(GOLDEN_FILE);
const GOLDEN_PATH = path.resolve(
  __dirname,
  '../../../../../../../../packages/agent-transcript/src/lib/subagent-tree/__tests__/parity/golden.json',
);
const SCOPE: SubagentHostScope = {
  projectId: PARITY_PROJECT_ID,
  worktreeId: PARITY_WORKTREE_ID,
};
const SCOPE_KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}`;

const describeTool: DescribeTool = (toolName, input) => ({
  label: toolLabelText(
    renderToStaticMarkup(<>{getToolDisplayInfo(toolName, input).label}</>),
  ),
  family: getToolFamilyFromName(toolName, undefined, input),
});

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      managedDelegation: {
        tree: jest.fn(() => Promise.resolve({ ok: true, entries: [] })),
      },
      activity: {
        startOutputPolling: jest.fn(() => Promise.resolve(undefined)),
        stopOutputPolling: jest.fn(() => Promise.resolve(undefined)),
      },
    },
  });
}

function rootTab(root: ParityFixture['root']): ChatTab {
  return {
    id: root.id,
    title: root.title,
    createdAt: '2026-10-16T12:00:00.000Z',
    messages: [],
    status: 'idle',
    error: null,
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

/** Applies a recording the way the desktop chat store receives it. */
function replay(
  root: ParityFixture['root'],
  events: readonly DesktopRecordedEvent[],
): ChatTab {
  let tab = rootTab(root);
  for (const event of events) {
    jest.setSystemTime(event.at);
    if ('output' in event) {
      useActivityStore.getState().appendBgProcessOutput({
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: root.id,
        taskId: event.output.taskId,
        outputFile: event.output.outputFile,
        lines: [...event.output.lines],
      });
      continue;
    }
    const data = { ...event.data };
    tab = applyTabEvent(tab, data);
    dispatchActivityEvent(SCOPE.projectId, SCOPE.worktreeId, root.id, data);
  }
  return tab;
}

interface Probe {
  current: SubagentTreeQuery | null;
}

function TreeProbe({
  probe,
  rootId,
}: {
  readonly probe: Probe;
  readonly rootId: string;
}): JSX.Element {
  probe.current = useSubagentTree(SCOPE, rootId, { enabled: true });
  return <></>;
}

const mounted: Root[] = [];

async function desktopProjection(fixture: ParityFixture): Promise<Json> {
  const tab = replay(fixture.root, fixture.desktopEvents());
  hydratedKeys.add(SCOPE_KEY);
  useChatStore.setState({
    worktreeChats: { [SCOPE_KEY]: { tabs: [tab], activeTabId: tab.id } },
  });
  const probe: Probe = { current: null };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  act(() => root.render(<TreeProbe probe={probe} rootId={fixture.root.id} />));
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
  const tree = probe.current?.tree ?? null;
  const transcripts: { [nodeId: string]: Json } = {};
  for (const node of tree === null ? [] : Array.from(tree.nodes.values())) {
    if (tree === null) continue;
    transcripts[node.id] = canonicalDesktopTranscript(
      buildSubagentChatTranscript({ tree, node, rootMessages: tab.messages })
        .items,
      describeTool,
    );
  }
  const processes = useActivityStore.getState().bgProcesses[SCOPE_KEY] ?? [];
  return {
    tree: canonicalTree(tree),
    transcripts,
    backgroundTasks: canonicalBackgroundTasks(
      processes.map(backgroundProcessToTask),
    ),
  };
}

beforeAll(() => {
  initClaudeModels([
    { id: CLAUDE_PARITY_MODEL.id, label: CLAUDE_PARITY_MODEL.label },
  ]);
});

afterAll(() => {
  initClaudeModels([]);
});

beforeEach(() => {
  jest.useFakeTimers();
  installApi();
  useChatStore.setState(useChatStore.getInitialState());
  useActivityStore.setState({ bgProcesses: {}, toolUses: {} });
  resetSubagentTreeStoreForTests();
});

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  hydratedKeys.delete(SCOPE_KEY);
  useActivityStore
    .getState()
    .cleanupWorktree(SCOPE.projectId, SCOPE.worktreeId);
  useChatStore.setState(useChatStore.getInitialState());
  resetSubagentTreeStoreForTests();
  document.body.replaceChildren();
  jest.clearAllTimers();
  jest.useRealTimers();
});

const updated: { [fixture: string]: Json } = {};

afterAll(() => {
  if (process.env.PARITY_GOLDEN_UPDATE !== '1') return;
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(updated, null, 2)}\n`);
});

describe('subagent parity golden (CAN-4051), desktop path', () => {
  it.each(PARITY_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    'projects the %s recording to the golden tree, transcripts and background tasks',
    async (name, fixture) => {
      const actual = await desktopProjection(fixture);
      if (process.env.PARITY_GOLDEN_UPDATE === '1') {
        updated[name] = goldenWith(
          'desktop',
          name,
          actual,
          getAt(GOLDEN, [name]),
        );
        return;
      }
      const golden = getAt(GOLDEN, [name]);
      if (golden === undefined) throw new Error(`golden.json has no ${name}`);
      expect(actual).toEqual(expectedFor('desktop', name, golden));
    },
  );
});
