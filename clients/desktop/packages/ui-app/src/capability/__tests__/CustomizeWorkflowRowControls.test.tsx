/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import { CustomizeWorkflowRowControls } from '../CustomizeWorkflowRowControls';
import type { CustomizeWorkflowAvailability } from '../customizeWorkflowActions';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function entry(overrides: Partial<UnifiedPluginEntry>): UnifiedPluginEntry {
  return {
    id: 'skill:local:alpha',
    kind: 'skill',
    origin: 'installed-standalone',
    name: 'Alpha',
    description: '',
    categories: [],
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'installed',
    recommended: false,
    ref: { type: 'skill', sourceId: 'local', skillName: 'alpha' },
    ...overrides,
  };
}

const AUTOMATION = entry({
  id: 'automation:local:standup',
  kind: 'automation',
  name: 'Morning standup',
  workflow: { triggerText: 'Every day at 09:00', enabled: false },
  ref: { type: 'automation', activityId: 'standup' },
});

const PIPELINE = entry({
  id: 'pipeline:user:nightly',
  kind: 'pipeline',
  name: 'Nightly build',
  workflow: { triggerText: 'Manual', runnable: true },
  ref: { type: 'pipeline', pipelineId: 'nightly', source: 'user' },
});

const ALL: CustomizeWorkflowAvailability = {
  run: { available: true },
  toggle: { available: true },
  runNow: { available: true },
  edit: { available: true },
  viewRuns: { available: true },
  delete: { available: true },
};

describe('CustomizeWorkflowRowControls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    target: UnifiedPluginEntry,
    {
      availability = ALL,
      busy = false,
      onRun = jest.fn(),
      onToggle = jest.fn(),
    }: {
      availability?: CustomizeWorkflowAvailability;
      busy?: boolean;
      onRun?: () => void;
      onToggle?: () => void;
    } = {},
  ): void {
    act(() =>
      root.render(
        <CustomizeWorkflowRowControls
          entry={target}
          availability={availability}
          busy={busy}
          onRun={onRun}
          onToggle={onToggle}
        />,
      ),
    );
  }

  function q(testId: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
  }

  it('draws an automation’s switch with its state as the name', () => {
    const onToggle = jest.fn();
    render(AUTOMATION, { onToggle });
    const toggle = q(`customize-workflow-toggle-${AUTOMATION.id}`);
    expect(toggle?.getAttribute('aria-label')).toBe('Morning standup is off');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(q('customize-row-status-slot')).not.toBeNull();
  });

  it('draws a pipeline’s Run', () => {
    const onRun = jest.fn();
    render(PIPELINE, { onRun });
    const run = q(`customize-workflow-run-${PIPELINE.id}`);
    expect(run?.getAttribute('aria-label')).toBe('Run Nightly build');
    act(() => run?.click());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('disables Run with the reason as its name when it cannot start', () => {
    render(PIPELINE, {
      availability: {
        ...ALL,
        run: { available: false, reason: 'Starts from an approved plan' },
      },
    });
    const run = q(`customize-workflow-run-${PIPELINE.id}`);
    expect(run?.disabled).toBe(true);
    expect(run?.getAttribute('aria-label')).toBe(
      'Starts from an approved plan',
    );
  });

  it('disables both controls while the row is busy', () => {
    render(AUTOMATION, { busy: true });
    expect(q(`customize-workflow-toggle-${AUTOMATION.id}`)?.disabled).toBe(
      true,
    );
    render(PIPELINE, { busy: true });
    expect(q(`customize-workflow-run-${PIPELINE.id}`)?.disabled).toBe(true);
  });

  it('renders nothing for other kinds', () => {
    render(entry({}));
    expect(container.innerHTML).toBe('');
  });
});
