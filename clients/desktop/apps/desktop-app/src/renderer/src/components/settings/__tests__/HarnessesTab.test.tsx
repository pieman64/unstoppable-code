/** @jest-environment jsdom */
/**
 * HarnessesTab + harness-assignment store tests.
 *
 * Uses the repo's createRoot + act jsdom convention (no @testing-library).
 * The root mounts on document.body so the row menus' FloatingMenu portal
 * (also rendered into document.body) is covered by React event delegation.
 *
 * @dnd-kit/core is mocked with a controllable pass-through: the DndContext
 * props (onDragStart/onDragEnd/announcements/…) are captured so tests can
 * drive pointer drops synthetically. Keyboard dragging is implemented by the
 * board itself and exercised with DOM key events; real sensor/layout behavior
 * is covered by the Electron spec.
 */
let mockCursorAvailable = false;
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => mockCursorAvailable,
}));
jest.mock('@/hooks/useCursorModels', () => ({
  useCursorModels: (): { models: never[]; message: undefined } => ({
    models: [],
    message: undefined,
  }),
}));
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ModelHarnessAssignment,
  ModelHarnessAssignmentSnapshot,
  ModelRegistrySnapshot,
} from '@canopy/desktop-shared/types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const mockDnd: {
  props: CapturedDnd | null;
} = { props: null };

interface MockDraggableResult {
  attributes: Record<string, unknown>;
  listeners: Record<string, jest.Mock>;
  setNodeRef: () => void;
  isDragging: boolean;
}

interface MockDroppableResult {
  setNodeRef: () => void;
  isOver: boolean;
  id: string;
}

interface MockDndContextProps extends CapturedDnd {
  children?: ReactNode;
}

jest.mock('@dnd-kit/core', () => {
  return {
    DndContext: (props: MockDndContextProps): ReactNode => {
      mockDnd.props = props;
      return props.children ?? null;
    },
    DragOverlay: (props: { children?: ReactNode }): ReactNode =>
      props.children ?? null,
    PointerSensor: function PointerSensor(): void {},
    KeyboardSensor: function KeyboardSensor(): void {},
    useSensor: (...args: unknown[]): unknown[] => args,
    useSensors: (...args: unknown[]): unknown[] => args,
    rectIntersection: jest.fn(),
    useDraggable: ({ id }: { id: string }): MockDraggableResult => ({
      attributes: {
        role: 'button',
        tabIndex: 0,
        'aria-roledescription': 'draggable',
        'data-draggable-id': id,
      },
      listeners: { onPointerDown: jest.fn(), onKeyDown: jest.fn() },
      setNodeRef: (): void => undefined,
      isDragging: false,
    }),
    useDroppable: ({ id }: { id: string }): MockDroppableResult => ({
      setNodeRef: (): void => undefined,
      isOver: false,
      id,
    }),
  };
});

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): {
      reconcileModelRegistry: jest.Mock;
      syncActiveEmptyTabToDefaults: jest.Mock;
    } => ({
      reconcileModelRegistry: jest.fn(),
      syncActiveEmptyTabToDefaults: jest.fn(() => Promise.resolve()),
    }),
  },
}));

jest.mock('@/stores/appAdvisorStore', () => ({
  useAppAdvisorStore: {
    getState: (): { applyPreferences: jest.Mock } => ({
      applyPreferences: jest.fn(),
    }),
  },
}));

// Imported AFTER the mocks so the store/tab pick up the mocked modules.
import { HarnessesTab } from '../HarnessesTab';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => {
    throw new Error('Deferred promise has not initialized resolve yet.');
  };
  let reject: Deferred<T>['reject'] = () => {
    throw new Error('Deferred promise has not initialized reject yet.');
  };
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assignment(
  overrides: Partial<ModelHarnessAssignment> & { modelId: string },
): ModelHarnessAssignment {
  return {
    source: 'ai-gateway',
    harness: 'claude',
    defaultHarness: 'claude',
    configurable: true,
    overridden: false,
    ...overrides,
  };
}

/** Fixture snapshot spanning every source group. */
function fixtureSnapshot(revision = 1): ModelHarnessAssignmentSnapshot {
  return {
    revision,
    assignments: [
      assignment({
        modelId: 'opus',
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
      }),
      assignment({
        modelId: 'sonnet',
        source: 'claude-managed',
        harness: 'claude',
        defaultHarness: 'claude',
        configurable: false,
      }),
      assignment({
        modelId: 'gpt-6',
        source: 'codex-managed',
        harness: 'codex',
        defaultHarness: 'codex',
        configurable: false,
      }),
      // Intentionally out of alphabetical order to prove gateway label sort.
      assignment({ modelId: 'zeta-model', harness: 'claude' }),
      assignment({ modelId: 'alpha-model', harness: 'claude' }),
      assignment({
        modelId: 'deepseek-v4-pro',
        harness: 'codex',
        defaultHarness: 'codex',
      }),
      assignment({
        modelId: 'ollama-llama4',
        source: 'ollama',
        harness: 'codex',
        defaultHarness: 'codex',
      }),
    ],
  };
}

function emptyRegistrySnapshot(
  harnessAssignments?: ModelHarnessAssignmentSnapshot,
): ModelRegistrySnapshot {
  return {
    claude: [],
    codex: [],
    ollama: [],
    agents: [],
    aliases: {},
    aiGatewayModels: [],
    gatewayRoutes: [],
    ...(harnessAssignments ? { harnessAssignments } : {}),
  };
}

const api = {
  harnessAssignments: {
    load: jest.fn(),
    set: jest.fn(),
    reset: jest.fn(),
  },
  onModelRegistryUpdated: jest.fn(() => (): void => undefined),
};

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderTab(): Promise<void> {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const reactRoot = createRoot(mount);
  container = mount;
  root = reactRoot;
  act(() => {
    reactRoot.render(<HarnessesTab />);
  });
  await flush();
}

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function requireEl(testId: string): HTMLElement {
  const el = query(testId);
  if (!el) {
    throw new Error(`Expected element with data-testid="${testId}"`);
  }
  return el;
}

function queryAll(testId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(`[data-testid="${testId}"]`));
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function pressKey(el: Element, code: string): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code }),
    );
  });
}

function resetStoreState(): void {
  useModelCatalogStore.setState({
    snapshot: null,
    modelGatewayEnforced: false,
    harnessAssignments: null,
    harnessAssignmentsLoadState: 'idle',
    harnessSaveFailed: false,
  });
}

interface CapturedDnd {
  onDragStart: (event: unknown) => void;
  onDragEnd: (event: unknown) => void;
  accessibility: {
    announcements: {
      onDragStart: (args: unknown) => string;
      onDragOver: (args: unknown) => string;
      onDragEnd: (args: unknown) => string;
      onDragCancel: (args: unknown) => string;
    };
    screenReaderInstructions: { draggable: string };
  };
}

function capturedDnd(): CapturedDnd {
  if (!mockDnd.props) {
    throw new Error('DndContext was not rendered');
  }
  return mockDnd.props;
}

beforeAll(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: api });
});

afterAll(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDnd.props = null;
  mockCursorAvailable = false;
  resetStoreState();
  api.harnessAssignments.load.mockResolvedValue(fixtureSnapshot());
});

afterEach(async () => {
  const reactRoot = root;
  if (reactRoot) {
    act(() => {
      reactRoot.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  // Let any dangling mutation-chain promises settle so module-level
  // bookkeeping (pending op counters) drains between tests.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('HarnessesTab display states', () => {
  it('shows the loading state until the snapshot arrives', async () => {
    const pending = deferred<ModelHarnessAssignmentSnapshot>();
    api.harnessAssignments.load.mockReturnValue(pending.promise);
    await renderTab();

    expect(query('settings-tab-harnesses')).not.toBeNull();
    // A form skeleton with no visible copy; "Loading" is screen-reader only.
    expect(
      query('harness-loading')?.querySelector(
        '[role="status"][data-testid="settings-skeleton-form"]',
      ),
    ).not.toBeNull();
    expect(query('harness-loading')?.textContent).toBe('Loading');
    expect(query('harness-column-claude')).toBeNull();

    pending.resolve(fixtureSnapshot());
    await flush();
    expect(query('harness-loading')).toBeNull();
    expect(query('harness-column-claude')).not.toBeNull();
  });

  it('shows the fatal failure state with a working Retry', async () => {
    api.harnessAssignments.load.mockRejectedValueOnce(new Error('boom'));
    await renderTab();

    const error = query('harness-load-error');
    expect(error?.textContent).toContain("Couldn't load harness assignments.");
    const retry = requireEl('harness-retry');
    expect(retry.textContent).toBe('Try again');

    api.harnessAssignments.load.mockResolvedValue(fixtureSnapshot());
    click(retry);
    await flush();

    expect(query('harness-load-error')).toBeNull();
    expect(query('harness-column-claude')).not.toBeNull();
    expect(query('harness-column-codex')).not.toBeNull();
  });

  it('shows the empty-column message when a harness has no models', async () => {
    api.harnessAssignments.load.mockResolvedValue({
      revision: 1,
      assignments: [
        assignment({
          modelId: 'gpt-6',
          source: 'codex-managed',
          harness: 'codex',
          defaultHarness: 'codex',
          configurable: false,
        }),
      ],
    });
    await renderTab();

    expect(query('harness-column-empty-claude')?.textContent).toBe(
      'No models assigned to this harness.',
    );
    expect(query('harness-column-empty-codex')).toBeNull();
  });
});

describe('HarnessesTab layout and ordering', () => {
  it('renders fixed source-group order and sorts gateway rows by label', async () => {
    await renderTab();

    // The managed group renders no heading: it can only ever appear in its own
    // native column, so the heading would just repeat the column title.
    const claudeColumn = requireEl('harness-column-claude');
    const groupLabels = Array.from(
      claudeColumn.querySelectorAll('[data-testid^="harness-group-label-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(groupLabels).toEqual(['harness-group-label-ai-gateway-claude']);
    // The group itself still exists and keeps its accessible name.
    const claudeManaged = requireEl('harness-group-claude-managed-claude');
    expect(claudeManaged.getAttribute('role')).toBe('group');
    expect(claudeManaged.getAttribute('aria-label')).toBe('Claude');

    // Managed rows keep snapshot (package) order and lead the column.
    const claudeRows = Array.from(
      claudeColumn.querySelectorAll('[data-testid^="harness-row-"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => !id?.includes('menu'));
    expect(claudeRows).toEqual([
      'harness-row-opus',
      'harness-row-sonnet',
      // Gateway rows sorted alphabetically by label, not snapshot order.
      'harness-row-alpha-model',
      'harness-row-zeta-model',
    ]);

    const codexColumn = requireEl('harness-column-codex');
    const codexGroups = Array.from(
      codexColumn.querySelectorAll('[data-testid^="harness-group-label-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(codexGroups).toEqual([
      'harness-group-label-ai-gateway-codex',
      'harness-group-label-ollama-codex',
    ]);
    const codexManaged = requireEl('harness-group-codex-managed-codex');
    expect(codexManaged.getAttribute('role')).toBe('group');
    expect(codexManaged.getAttribute('aria-label')).toBe('Codex');

    // Managed rows lead the Codex column too.
    const codexRows = Array.from(
      codexColumn.querySelectorAll('[data-testid^="harness-row-"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => !id?.includes('menu'));
    expect(codexRows).toEqual([
      'harness-row-gpt-6',
      'harness-row-deepseek-v4-pro',
      'harness-row-ollama-llama4',
    ]);
  });

  it('keeps columns side by side inside a horizontally scrollable region', async () => {
    await renderTab();
    const scroller = requireEl('harness-columns-scroller');
    expect(scroller.className).toContain('overflow-x-auto');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    const grid = scroller.firstElementChild;
    expect(grid).toBeInstanceOf(HTMLElement);
    if (!(grid instanceof HTMLElement)) {
      throw new Error('Harness columns grid was not rendered');
    }
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).toContain('min-w-');
  });

  it('renders no Custom Agent rows', async () => {
    await renderTab();
    const rowIds = queryAll('harness-column-claude')
      .concat(queryAll('harness-column-codex'))
      .flatMap((column) =>
        Array.from(column.querySelectorAll('[data-harness-row-kind]')).map(
          (el) => el.getAttribute('data-testid'),
        ),
      );
    expect(rowIds).toHaveLength(7);
    expect(rowIds.some((id) => id?.includes('agent_model_'))).toBe(false);
  });
});

describe('HarnessesTab managed locks', () => {
  it('locks managed rows: no drag affordance, no menu, accessible label', async () => {
    await renderTab();

    const managed = requireEl('harness-row-opus');
    expect(managed.getAttribute('data-harness-row-kind')).toBe('managed');
    expect(managed.getAttribute('data-draggable-id')).toBeNull();
    expect(query('harness-row-menu-opus')).toBeNull();
    expect(managed.textContent).toContain('Managed by Claude');

    const codexManaged = requireEl('harness-row-gpt-6');
    expect(codexManaged.textContent).toContain('Managed by Codex');

    const configurable = requireEl('harness-row-alpha-model');
    expect(configurable.getAttribute('data-harness-row-kind')).toBe(
      'configurable',
    );
    expect(configurable.getAttribute('data-draggable-id')).toBe('alpha-model');
    expect(configurable.className).toContain('cursor-grab');
  });
});

describe('HarnessesTab actions menu', () => {
  it('keeps the ellipsis keyboard-focusable while visually hidden', async () => {
    await renderTab();
    const button = requireEl('harness-row-menu-alpha-model');
    expect(button.getAttribute('aria-label')).toBe('Actions for alpha-model');
    // The 28px icon circle sits in a wrapper that hides it until the row is
    // hovered or holds focus.
    expect(button.className).toContain('rounded-full');
    expect(button.parentElement?.className).toContain('opacity-0');
    expect(button.parentElement?.className).toContain(
      'group-focus-within:opacity-100',
    );
    expect(button.getAttribute('tabindex')).toBeNull(); // natural tab order
  });

  it('moves a row via the menu with exact copy and optimistic update', async () => {
    const pending = deferred<ModelHarnessAssignmentSnapshot>();
    api.harnessAssignments.set.mockReturnValue(pending.promise);
    await renderTab();

    click(requireEl('harness-row-menu-alpha-model'));
    const move = requireEl('harness-menu-move');
    expect(move.textContent).toBe('Move to Codex');
    click(move);
    await flush();

    expect(api.harnessAssignments.set).toHaveBeenCalledWith({
      modelId: 'alpha-model',
      harness: 'codex',
    });
    // Optimistic: the row is already rendered inside the Codex column.
    const codexColumn = requireEl('harness-column-codex');
    expect(
      codexColumn.querySelector('[data-testid="harness-row-alpha-model"]'),
    ).not.toBeNull();

    // Authoritative response replaces local state wholesale.
    const authoritative = fixtureSnapshot(2);
    authoritative.assignments = authoritative.assignments.map((entry) =>
      entry.modelId === 'alpha-model'
        ? { ...entry, harness: 'codex', overridden: true }
        : entry,
    );
    pending.resolve(authoritative);
    await flush();
    expect(useModelCatalogStore.getState().harnessAssignments?.revision).toBe(
      2,
    );
    expect(query('harness-save-error')).toBeNull();
  });

  it('offers Move to Claude from the Codex column', async () => {
    api.harnessAssignments.set.mockResolvedValue(fixtureSnapshot(2));
    await renderTab();

    click(requireEl('harness-row-menu-deepseek-v4-pro'));
    const move = requireEl('harness-menu-move');
    expect(move.textContent).toBe('Move to Claude');
  });

  it('shows Reset to recommended only on a live recommendation mismatch', async () => {
    const snapshot = fixtureSnapshot();
    snapshot.assignments = snapshot.assignments.map((entry) => {
      if (entry.modelId === 'zeta-model') {
        // Effective harness differs from the current recommendation.
        return {
          ...entry,
          harness: 'claude' as const,
          defaultHarness: 'codex' as const,
          overridden: true,
        };
      }
      if (entry.modelId === 'alpha-model') {
        // Backend retains a redundant override; recommendation matches.
        return { ...entry, overridden: true };
      }
      return entry;
    });
    api.harnessAssignments.load.mockResolvedValue(snapshot);
    api.harnessAssignments.reset.mockResolvedValue(fixtureSnapshot(2));
    await renderTab();

    click(requireEl('harness-row-menu-zeta-model'));
    const reset = requireEl('harness-menu-reset');
    expect(reset.textContent).toBe('Reset to recommended');
    // Reset leads with its icon and closes the menu in its own group.
    expect(reset.firstElementChild?.querySelector('svg')).toBeInstanceOf(
      Element,
    );
    expect(reset.previousElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    for (const move of Array.from(
      document.querySelectorAll('[data-testid="harness-menu-move"]'),
    )) {
      expect(move.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    }
    click(reset);
    await flush();
    expect(api.harnessAssignments.reset).toHaveBeenCalledWith({
      modelId: 'zeta-model',
    });

    // Redundant-override row: no reset affordance.
    click(requireEl('harness-row-menu-alpha-model'));
    expect(query('harness-menu-reset')).toBeNull();

    // Ollama rows are configurable but never offer reset.
    click(requireEl('harness-row-menu-ollama-llama4'));
    expect(query('harness-menu-reset')).toBeNull();
  });

  it('rolls back and alerts with the exact copy when a save fails', async () => {
    api.harnessAssignments.set.mockRejectedValue(new Error('nope'));
    await renderTab();

    click(requireEl('harness-row-menu-alpha-model'));
    click(requireEl('harness-menu-move'));
    await flush();

    const alert = requireEl('harness-save-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain(
      'Couldn’t save that harness change. The previous assignment was restored.',
    );
    // Rolled back into the Claude column.
    const claudeColumn = requireEl('harness-column-claude');
    expect(
      claudeColumn.querySelector('[data-testid="harness-row-alpha-model"]'),
    ).not.toBeNull();
  });
});

describe('HarnessesTab drag interactions', () => {
  it('moves a configurable row with lift, arrow, and drop keys', async () => {
    const pending = deferred<ModelHarnessAssignmentSnapshot>();
    api.harnessAssignments.set.mockReturnValue(pending.promise);
    await renderTab();

    const row = requireEl('harness-row-alpha-model');
    pressKey(row, 'Enter');
    expect(query('harness-drag-overlay')?.textContent).toBe('alpha-model');

    pressKey(row, 'ArrowRight');
    expect(requireEl('harness-column-codex').dataset.dropHighlight).toBe(
      'true',
    );

    pressKey(row, 'Enter');
    await flush();
    expect(api.harnessAssignments.set).toHaveBeenCalledWith({
      modelId: 'alpha-model',
      harness: 'codex',
    });
    expect(query('harness-drag-overlay')).toBeNull();
    expect(
      requireEl('harness-column-codex').querySelector(
        '[data-testid="harness-row-alpha-model"]',
      ),
    ).not.toBeNull();

    pending.resolve(fixtureSnapshot(2));
    await flush();
  });

  it('moves a configurable row on an opposite-column drop', async () => {
    api.harnessAssignments.set.mockResolvedValue(fixtureSnapshot(2));
    await renderTab();

    const dnd = capturedDnd();
    act(() => {
      dnd.onDragStart({ active: { id: 'alpha-model' } });
    });
    expect(query('harness-drag-overlay')?.textContent).toBe('alpha-model');
    act(() => {
      dnd.onDragEnd({
        active: { id: 'alpha-model' },
        over: { id: 'codex' },
      });
    });
    await flush();
    expect(api.harnessAssignments.set).toHaveBeenCalledWith({
      modelId: 'alpha-model',
      harness: 'codex',
    });
    expect(query('harness-drag-overlay')).toBeNull();
  });

  it('treats same-column drops and managed rows as no-ops', async () => {
    await renderTab();
    const dnd = capturedDnd();
    act(() => {
      dnd.onDragEnd({
        active: { id: 'alpha-model' },
        over: { id: 'claude' },
      });
      dnd.onDragEnd({ active: { id: 'opus' }, over: { id: 'codex' } });
      dnd.onDragEnd({ active: { id: 'alpha-model' }, over: null });
    });
    await flush();
    expect(api.harnessAssignments.set).not.toHaveBeenCalled();
  });

  it('announces pickup, hover, drop, and cancellation', async () => {
    await renderTab();
    const { accessibility } = capturedDnd();

    expect(
      accessibility.announcements.onDragStart({
        active: { id: 'alpha-model' },
      }),
    ).toBe('Picked up alpha-model. It is currently in the Claude column.');
    expect(
      accessibility.announcements.onDragOver({
        active: { id: 'alpha-model' },
        over: { id: 'codex' },
      }),
    ).toBe('alpha-model is over the Codex column.');
    expect(
      accessibility.announcements.onDragEnd({
        active: { id: 'alpha-model' },
        over: { id: 'codex' },
      }),
    ).toBe('alpha-model was moved to the Codex column.');
    expect(
      accessibility.announcements.onDragEnd({
        active: { id: 'alpha-model' },
        over: { id: 'claude' },
      }),
    ).toBe('alpha-model was dropped. No changes were made.');
    expect(
      accessibility.announcements.onDragCancel({
        active: { id: 'alpha-model' },
      }),
    ).toBe('Dragging was cancelled. alpha-model stayed in the Claude column.');
    expect(accessibility.screenReaderInstructions.draggable).toContain(
      'arrow key',
    );
  });
});

function rowLabel(modelId: string): Element | null {
  return requireEl(`harness-row-${modelId}`).querySelector('span');
}

describe('HarnessesTab model labels', () => {
  it('shows an Ollama model label without its prefix', async () => {
    await renderTab();

    expect(rowLabel('ollama-llama4')?.textContent).toBe('llama4');
  });

  it('shows a catalog model label in the drag overlay', async () => {
    await renderTab();
    act(() => {
      capturedDnd().onDragStart({ active: { id: 'opus' } });
    });
    expect(query('harness-drag-overlay')?.textContent).toBe('opus');
  });
});

describe('harness assignment store convergence', () => {
  it('applies only the newest mutation result on stale success', async () => {
    api.harnessAssignments.load.mockResolvedValue(fixtureSnapshot(1));
    await useModelCatalogStore.getState().loadHarnessAssignments();

    const first = deferred<ModelHarnessAssignmentSnapshot>();
    const second = deferred<ModelHarnessAssignmentSnapshot>();
    api.harnessAssignments.set
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const p1 = useModelCatalogStore
      .getState()
      .setModelHarness('alpha-model', 'codex');
    const p2 = useModelCatalogStore
      .getState()
      .setModelHarness('zeta-model', 'codex');

    const stale = fixtureSnapshot(2);
    const fresh = fixtureSnapshot(3);
    fresh.assignments = fresh.assignments.map((entry) =>
      entry.modelId === 'alpha-model' || entry.modelId === 'zeta-model'
        ? { ...entry, harness: 'codex' as const, overridden: true }
        : entry,
    );
    first.resolve(stale);
    second.resolve(fresh);
    await p1;
    await p2;

    const state = useModelCatalogStore.getState().harnessAssignments;
    // The stale (superseded) success was skipped; the newest response won.
    expect(state?.revision).toBe(3);
    expect(
      state?.assignments.find((entry) => entry.modelId === 'zeta-model')
        ?.harness,
    ).toBe('codex');
  });

  it('reloads authoritative state when a superseded mutation fails', async () => {
    api.harnessAssignments.load.mockResolvedValue(fixtureSnapshot(1));
    await useModelCatalogStore.getState().loadHarnessAssignments();

    const first = deferred<ModelHarnessAssignmentSnapshot>();
    const second = deferred<ModelHarnessAssignmentSnapshot>();
    api.harnessAssignments.set
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const reloaded = fixtureSnapshot(5);
    api.harnessAssignments.load.mockResolvedValue(reloaded);

    const p1 = useModelCatalogStore
      .getState()
      .setModelHarness('alpha-model', 'codex');
    const p2 = useModelCatalogStore
      .getState()
      .setModelHarness('zeta-model', 'codex');

    first.reject(new Error('save failed'));
    second.resolve(fixtureSnapshot(4));
    await p1;
    await p2;

    const state = useModelCatalogStore.getState();
    expect(state.harnessSaveFailed).toBe(true);
    // The superseded failure triggered an authoritative reload; the newest
    // snapshot (by revision) wins.
    expect(state.harnessAssignments?.revision).toBe(5);
  });

  it('converges to registry broadcasts across windows by revision', async () => {
    api.harnessAssignments.load.mockResolvedValue(fixtureSnapshot(3));
    await useModelCatalogStore.getState().loadHarnessAssignments();

    // A newer broadcast replaces local state…
    const newer = fixtureSnapshot(7);
    useModelCatalogStore.getState().hydrate(emptyRegistrySnapshot(newer));
    expect(useModelCatalogStore.getState().harnessAssignments?.revision).toBe(
      7,
    );

    // …an older broadcast is ignored…
    useModelCatalogStore
      .getState()
      .hydrate(emptyRegistrySnapshot(fixtureSnapshot(4)));
    expect(useModelCatalogStore.getState().harnessAssignments?.revision).toBe(
      7,
    );

    // …and a registry snapshot without assignments keeps current state.
    useModelCatalogStore.getState().hydrate(emptyRegistrySnapshot());
    expect(useModelCatalogStore.getState().harnessAssignments?.revision).toBe(
      7,
    );
  });

  it('defers a broadcast that lands mid-mutation until the chain drains', async () => {
    api.harnessAssignments.load.mockResolvedValue(fixtureSnapshot(1));
    await useModelCatalogStore.getState().loadHarnessAssignments();

    const pendingSet = deferred<ModelHarnessAssignmentSnapshot>();
    api.harnessAssignments.set.mockReturnValue(pendingSet.promise);
    const p = useModelCatalogStore
      .getState()
      .setModelHarness('alpha-model', 'codex');

    // Broadcast arrives while the mutation is in flight: buffered, and the
    // optimistic row keeps its position.
    useModelCatalogStore
      .getState()
      .hydrate(emptyRegistrySnapshot(fixtureSnapshot(9)));
    expect(
      useModelCatalogStore
        .getState()
        .harnessAssignments?.assignments.find(
          (entry) => entry.modelId === 'alpha-model',
        )?.harness,
    ).toBe('codex');

    pendingSet.resolve(fixtureSnapshot(2));
    await p;
    // On drain the buffered (newest) broadcast wins.
    expect(useModelCatalogStore.getState().harnessAssignments?.revision).toBe(
      9,
    );
  });
});

test('an enforced gateway removes Cursor destinations and projects saved defaults to native', async () => {
  const flags = useFeatureFlagsStore.getState();
  const previous = flags.snapshot;
  flags.setSnapshot({
    ...previous,
    values: {
      ...previous.values,
      'canopy-desktop-cursor-harness-released': true,
    },
  });
  try {
    mockCursorAvailable = true;
    useModelCatalogStore.setState({ modelGatewayEnforced: true });
    api.harnessAssignments.load.mockResolvedValue({
      revision: 1,
      assignments: [
        assignment({
          modelId: 'gateway-alpha',
          harness: 'cursor',
          defaultHarness: 'codex',
          overridden: true,
          availableHarnesses: ['claude', 'codex', 'cursor'],
        }),
      ],
    });
    await renderTab();
    expect(query('harness-column-cursor')).toBeNull();
    expect(
      requireEl('harness-column-codex').contains(
        requireEl('harness-row-gateway-alpha'),
      ),
    ).toBe(true);
    click(requireEl('harness-row-menu-gateway-alpha'));
    expect(document.body.textContent).not.toContain('Move to Cursor');
  } finally {
    act(() => flags.setSnapshot(previous));
  }
});

test('released Cursor is discoverable before connection without permitting model assignment', async () => {
  const flags = useFeatureFlagsStore.getState();
  const previous = flags.snapshot;
  flags.setSnapshot({
    ...previous,
    values: {
      ...previous.values,
      'canopy-desktop-cursor-harness': true,
      'canopy-desktop-cursor-harness-released': true,
    },
  });
  try {
    await renderTab();
    expect(query('harness-column-cursor')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Move to Cursor');
    act(() =>
      capturedDnd().onDragEnd({
        active: { id: 'alpha-model' },
        over: { id: 'cursor' },
      }),
    );
    expect(api.harnessAssignments.set).not.toHaveBeenCalled();
    act(() => query('harness-connect-cursor')?.click());
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'account',
    );
  } finally {
    act(() => flags.setSnapshot(previous));
  }
});
