/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LedgerActorRef,
  LedgerOwnerCandidate,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewFileCandidate } from '@canopy/protocol/ledger-view';
import { LedgerEntryForm, type LedgerEntryFormValue } from '../LedgerEntryForm';
import { LedgerFileSearch } from '../LedgerFileSearch';
import { LedgerOwnerPicker } from '../LedgerOwnerPicker';
import { LedgerStatusControl } from '../LedgerStatusControl';
import { LedgerTargetPicker } from '../LedgerTargetPicker';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const YOU: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
};
const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'chat',
  authorityId: 'authority-1',
};
const AGENT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a3',
  kind: 'pipeline_agent',
  authorityId: 'authority-1',
};
const SELF_CANDIDATE: LedgerOwnerCandidate = {
  actor: YOU,
  displayName: 'You',
  eligibilityToken: 'token-you',
  isSelf: true,
};
const CHAT_CANDIDATE: LedgerOwnerCandidate = {
  actor: CHAT,
  displayName: 'Parser fixes',
  eligibilityToken: 'token-chat',
  isSelf: false,
};
const AGENT_CANDIDATE: LedgerOwnerCandidate = {
  actor: AGENT,
  displayName: 'Review changes · Release checks',
  eligibilityToken: 'token-agent',
  isSelf: false,
  pipelineAgent: {
    executionId: '12345678-aaaa-4bbb-8ccc-000000000001',
    jobId: 'review',
    stepId: 'agent',
    attempt: 1,
    checkpointId: 'checkpoint-1',
    pausedAt: null,
  },
};

const BLANK: LedgerEntryFormValue = {
  type: 'TASK',
  title: '',
  content: '',
  highlights: [],
  referenceFiles: [],
  status: 'TODO',
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
  return element;
}

function allByTestId(testId: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
}

/** Types into a React-controlled input or text area. */
function type(element: HTMLElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function renderForm(
  value: LedgerEntryFormValue,
  handlers: {
    onChange?: jest.Mock;
    onSave?: jest.Mock;
    onDiscard?: jest.Mock;
    correctionOf?: { title: string } | null;
    problem?: string | null;
    autoFocusContent?: boolean;
  } = {},
): void {
  act(() =>
    root.render(
      <LedgerEntryForm
        value={value}
        correctionOf={handlers.correctionOf ?? null}
        saving={false}
        problem={handlers.problem ?? null}
        autoFocusContent={handlers.autoFocusContent}
        ownerControl={(labelId) => (
          <button type="button" id={`${labelId}-picker`}>
            You
          </button>
        )}
        onChange={handlers.onChange ?? jest.fn()}
        onSave={handlers.onSave ?? jest.fn()}
        onDiscard={handlers.onDiscard ?? jest.fn()}
      />,
    ),
  );
}

describe('LedgerEntryForm', () => {
  it('labels every field and saves only a complete entry within the limits', () => {
    const onSave = jest.fn();
    renderForm(BLANK, { onSave });

    for (const testId of [
      'ledger-entry-form-type',
      'ledger-entry-form-status',
      'ledger-entry-form-title',
      'ledger-entry-form-content',
    ]) {
      const field = byTestId(testId);
      expect(
        document.querySelector(`label[for="${field.id}"]`)?.textContent,
      ).toBeTruthy();
    }
    expect(
      document.querySelector(
        `label[for="${byTestId('ledger-entry-form-title').id}"]`,
      )?.textContent,
    ).toBe('Title (optional)');
    // The owner label activates the picker it names.
    const ownerLabel = Array.from(document.querySelectorAll('label')).find(
      (label) => label.textContent === 'Owner',
    );
    expect(
      document.getElementById(ownerLabel?.htmlFor ?? '')?.textContent,
    ).toBe('You');
    expect(byTestId('ledger-entry-form-author').textContent).toBe(
      'Added by you',
    );
    const save = byTestId('ledger-entry-form-save');
    expect(save).toHaveProperty('disabled', true);
    expect(byTestId('ledger-entry-form-content')).toBe(document.activeElement);

    renderForm({ ...BLANK, content: 'Cover it.' }, { onSave });
    expect(document.body.textContent).toContain('0/100');
    expect(byTestId('ledger-entry-form-save')).toHaveProperty(
      'disabled',
      false,
    );
    act(() => byTestId('ledger-entry-form-save').click());
    expect(onSave).toHaveBeenCalledTimes(1);

    renderForm({ ...BLANK, title: 'Ship it', content: '   ' }, { onSave });
    expect(byTestId('ledger-entry-form-save')).toHaveProperty('disabled', true);

    renderForm(
      { ...BLANK, title: 'x'.repeat(101), content: 'Cover it.' },
      { onSave },
    );
    expect(byTestId('ledger-entry-form-save')).toHaveProperty('disabled', true);
    expect(document.body.textContent).toContain('101/100');
  });

  it('calls onDiscard from Cancel and keeps the existing test id', () => {
    const onDiscard = jest.fn();
    renderForm(BLANK, { onDiscard });

    const cancel = byTestId('ledger-entry-form-discard');
    expect(cancel.textContent).toBe('Cancel');
    act(() => cancel.click());
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('does not focus Content when autoFocusContent is false', () => {
    renderForm(BLANK, { autoFocusContent: false });

    expect(byTestId('ledger-entry-form-content')).not.toBe(
      document.activeElement,
    );
  });

  it('reports typed fields, the type and status, and highlights', () => {
    const onChange = jest.fn();
    renderForm(BLANK, { onChange });

    type(byTestId('ledger-entry-form-title'), 'Keep one writer');
    expect(onChange).toHaveBeenLastCalledWith({ title: 'Keep one writer' });
    type(byTestId('ledger-entry-form-content'), 'Only core commits.');
    expect(onChange).toHaveBeenLastCalledWith({
      content: 'Only core commits.',
    });
    act(() => byTestId('ledger-entry-form-type').click());
    act(() => byTestId('ledger-entry-form-type-option-decision').click());
    expect(onChange).toHaveBeenLastCalledWith({ type: 'DECISION' });
    expect(
      document.querySelector('[data-testid="ledger-entry-form-type-menu"]'),
    ).toBeNull();
    // Status is a picker like Type and Owner: open statuses, then the ones
    // that close the entry.
    const status = byTestId('ledger-entry-form-status');
    expect(status.textContent).toBe('To do');
    expect(
      (status.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((labelId) => document.getElementById(labelId)?.textContent),
    ).toEqual(['Status', 'To do']);
    act(() => status.click());
    expect(byTestId('ledger-status-menu').textContent).toContain(
      'Closes the entry',
    );
    act(() => byTestId('ledger-status-option-blocked').click());
    expect(onChange).toHaveBeenLastCalledWith({ status: 'BLOCKED' });
    act(() => byTestId('ledger-entry-form-add-highlight').click());
    expect(onChange).toHaveBeenLastCalledWith({ highlights: [''] });
  });

  it('shows each type with its icon, in the field and in its menu', () => {
    renderForm({ ...BLANK, type: 'ACTION' });

    const field = byTestId('ledger-entry-form-type');
    expect(field.textContent).toBe('Action');
    expect(
      field
        .querySelector('[data-testid="ledger-entry-type-icon"]')
        ?.getAttribute('data-type'),
    ).toBe('ACTION');
    // The visible label names the field, then its value.
    const labelledBy = (field.getAttribute('aria-labelledby') ?? '').split(' ');
    expect(
      labelledBy.map(
        (labelId) => document.getElementById(labelId)?.textContent,
      ),
    ).toEqual(['Type', 'Action']);

    act(() => field.click());
    const rows = Array.from(
      byTestId('ledger-entry-form-type-menu').querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ),
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      'Task',
      'Action',
      'Decision',
      'Observation',
    ]);
    expect(
      rows.map((row) =>
        row
          .querySelector('[data-testid="ledger-entry-type-icon"]')
          ?.getAttribute('data-type'),
      ),
    ).toEqual(['TASK', 'ACTION', 'DECISION', 'OBSERVATION']);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(
      rows[1]?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
  });

  it("sets and clears a file's line", () => {
    const onChange = jest.fn();
    renderForm(
      { ...BLANK, referenceFiles: [{ rootId: 'repo-1', path: 'src/a.ts' }] },
      { onChange },
    );
    const line = byTestId('ledger-entry-form-file').querySelector('input');
    if (line === null) throw new Error('Missing line input');

    type(line, '12');
    expect(onChange).toHaveBeenLastCalledWith({
      referenceFiles: [{ rootId: 'repo-1', path: 'src/a.ts', startLine: 12 }],
    });
    renderForm(
      {
        ...BLANK,
        referenceFiles: [{ rootId: 'repo-1', path: 'src/a.ts', startLine: 12 }],
      },
      { onChange },
    );
    const shown = byTestId('ledger-entry-form-file').querySelector('input');
    if (shown === null) throw new Error('Missing line input');
    expect(shown.value).toBe('12');
    type(shown, '');
    expect(onChange).toHaveBeenLastCalledWith({
      referenceFiles: [{ rootId: 'repo-1', path: 'src/a.ts' }],
    });
  });

  it('puts where the entry goes first, and waits to save until it is chosen', () => {
    const onSave = jest.fn();
    act(() =>
      root.render(
        <LedgerEntryForm
          value={{ ...BLANK, title: 'Ship it', content: 'Today.' }}
          correctionOf={null}
          saving={false}
          problem={null}
          targetControl={<div data-testid="target">Project</div>}
          saveBlockedReason="Choose a task first."
          onChange={jest.fn()}
          onSave={onSave}
          onDiscard={jest.fn()}
        />,
      ),
    );

    const form = byTestId('ledger-entry-form');
    const target = byTestId('target');
    expect(byTestId('ledger-entry-form-content')).toBe(document.activeElement);
    // The target comes before every field, and the form has no Owner of its
    // own: the target chooses it.
    expect(
      target.compareDocumentPosition(byTestId('ledger-entry-form-type')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      Array.from(form.querySelectorAll('label')).map(
        (label) => label.textContent,
      ),
    ).not.toContain('Owner');
    const save = byTestId('ledger-entry-form-save');
    expect(save).toHaveProperty('disabled', true);
    const blocked = byTestId('ledger-entry-form-save-blocked');
    expect(blocked.textContent).toBe('Choose a task first.');
    expect(save.getAttribute('aria-describedby')).toBe(blocked.id);
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("names a correction's original and puts a save problem first", () => {
    renderForm(BLANK, {
      correctionOf: { title: 'Keep one writer' },
      problem: "Couldn't save the entry. Try again.",
    });

    expect(document.querySelector('h2')?.textContent).toBe('Correction');
    expect(byTestId('ledger-entry-form-author').textContent).toContain(
      'Corrects "Keep one writer", which stays as it is.',
    );
    expect(byTestId('ledger-entry-form-problem').textContent).toContain(
      "Couldn't save the entry. Try again.",
    );
  });
});

describe('LedgerTargetPicker', () => {
  const OPTIONS = [
    { id: 'wt-1', label: 'Parser fixes' },
    { id: 'wt-2', label: 'Release notes', unavailable: 'Has a draft' },
    { id: 'wt-3', label: 'Docs' },
  ];

  function renderPicker(
    props: Partial<Parameters<typeof LedgerTargetPicker>[0]> = {},
  ): void {
    act(() =>
      root.render(
        <>
          <span id="task-label">Task</span>
          <LedgerTargetPicker
            id="task"
            labelId="task-label"
            options={OPTIONS}
            value={null}
            placeholder="Choose a task"
            onSelect={jest.fn()}
            data-testid="target-task"
            {...props}
          />
        </>,
      ),
    );
  }

  it('shows its placeholder until one is chosen, and names itself by its label', () => {
    renderPicker();
    const trigger = byTestId('target-task');
    expect(trigger.id).toBe('task');
    expect(trigger.textContent).toBe('Choose a task');
    expect(trigger.getAttribute('data-placeholder')).toBe('true');
    const labelledBy = (trigger.getAttribute('aria-labelledby') ?? '').split(
      ' ',
    );
    expect(
      labelledBy.map(
        (labelId) => document.getElementById(labelId)?.textContent,
      ),
    ).toEqual(['Task', 'Choose a task']);

    renderPicker({ value: 'wt-3' });
    expect(byTestId('target-task').textContent).toBe('Docs');
    expect(byTestId('target-task').hasAttribute('data-placeholder')).toBe(
      false,
    );
  });

  it('checks the chosen row, and keeps an unavailable one with its reason', () => {
    const onSelect = jest.fn();
    renderPicker({ value: 'wt-1', onSelect });
    act(() => byTestId('target-task').click());

    const rows = allByTestId('target-task-option');
    expect(rows.map((row) => row.getAttribute('data-option-id'))).toEqual([
      'wt-1',
      'wt-2',
      'wt-3',
    ]);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(rows[1]).toHaveProperty('disabled', true);
    expect(rows[1]?.textContent).toBe('Release notesHas a draft');

    act(() => rows[1]?.click());
    expect(onSelect).not.toHaveBeenCalled();
    act(() => rows[2]?.click());
    expect(onSelect).toHaveBeenCalledWith('wt-3');
    expect(
      document.querySelector('[data-testid="target-task-menu"]'),
    ).toBeNull();
  });

  it('says why it cannot change now', () => {
    renderPicker({
      value: 'wt-1',
      disabled: true,
      disabledReason: 'Save or discard this draft before moving it.',
    });
    const trigger = byTestId('target-task');
    expect(trigger).toHaveProperty('disabled', true);
    expect(trigger.getAttribute('title')).toBe(
      'Save or discard this draft before moving it.',
    );
  });
});

describe('LedgerStatusControl', () => {
  it('lists open statuses, then the ones that close the entry, and reports a change', () => {
    const onChange = jest.fn();
    act(() =>
      root.render(
        <LedgerStatusControl status="IN_PROGRESS" onChange={onChange} />,
      ),
    );
    act(() => byTestId('ledger-status-control').click());

    expect(
      byTestId('ledger-status-option-in_progress').getAttribute('aria-checked'),
    ).toBe('true');
    expect(byTestId('ledger-status-menu').textContent).toContain(
      'Closes the entry',
    );
    act(() => byTestId('ledger-status-option-completed').click());
    expect(onChange).toHaveBeenCalledWith('COMPLETED');
  });
});

describe('LedgerOwnerPicker', () => {
  it('always offers You, tells chats and paused pipeline agents apart, and explains assignment', () => {
    const onOpen = jest.fn();
    const onSelect = jest.fn();
    act(() =>
      root.render(
        <LedgerOwnerPicker
          ownerName="You"
          ownerActorId={YOU.actorId}
          candidates={[SELF_CANDIDATE, CHAT_CANDIDATE, AGENT_CANDIDATE]}
          status="ready"
          onOpen={onOpen}
          onSelect={onSelect}
        />,
      ),
    );
    act(() => byTestId('ledger-owner-picker').click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(
      byTestId('ledger-owner-option-you').getAttribute('aria-checked'),
    ).toBe('true');
    const [chat, agent] = allByTestId('ledger-owner-option');
    expect(chat?.textContent).toContain('Parser fixes');
    expect(chat?.textContent).toContain('Chat');
    expect(agent?.textContent).toContain(
      'Pipeline run 12345678, job review, step agent',
    );
    expect(agent?.getAttribute('title')).toContain('Checkpoint checkpoint-1');
    expect(byTestId('ledger-owner-menu').textContent).toContain(
      'Assigning this entry does not start the session.',
    );

    act(() => chat?.click());
    expect(onSelect).toHaveBeenCalledWith(CHAT_CANDIDATE);
  });

  it('offers another pause of the chosen pipeline agent as a different owner', () => {
    const onSelect = jest.fn();
    const pause = AGENT_CANDIDATE.pipelineAgent;
    if (pause === undefined) throw new Error('No pause');
    const laterPause: LedgerOwnerCandidate = {
      ...AGENT_CANDIDATE,
      eligibilityToken: 'token-agent-later',
      pipelineAgent: { ...pause, checkpointId: 'checkpoint-2' },
    };
    act(() =>
      root.render(
        <LedgerOwnerPicker
          ownerName={AGENT_CANDIDATE.displayName}
          ownerActorId={AGENT.actorId}
          ownerPipelineAgent={pause}
          candidates={[SELF_CANDIDATE, laterPause]}
          status="ready"
          onOpen={jest.fn()}
          onSelect={onSelect}
        />,
      ),
    );
    act(() => byTestId('ledger-owner-picker').click());

    const [agent] = allByTestId('ledger-owner-option');
    expect(agent?.getAttribute('aria-checked')).toBe('false');
    act(() => agent?.click());
    expect(onSelect).toHaveBeenCalledWith(laterPause);
  });

  it('says why the owner cannot be chosen yet', () => {
    act(() =>
      root.render(
        <LedgerOwnerPicker
          variant="field"
          ownerName="You"
          ownerActorId={null}
          candidates={[]}
          status="idle"
          onOpen={jest.fn()}
          onSelect={jest.fn()}
          disabledReason="Choose a task first."
        />,
      ),
    );
    const trigger = byTestId('ledger-owner-picker');
    expect(trigger).toHaveProperty('disabled', true);
    expect(trigger.getAttribute('title')).toBe('Choose a task first.');
  });

  it('marks the chosen pause, and an owner known only by its actor', () => {
    for (const ownerPipelineAgent of [
      AGENT_CANDIDATE.pipelineAgent,
      undefined,
    ]) {
      act(() =>
        root.render(
          <LedgerOwnerPicker
            ownerName={AGENT_CANDIDATE.displayName}
            ownerActorId={AGENT.actorId}
            ownerPipelineAgent={ownerPipelineAgent}
            candidates={[SELF_CANDIDATE, AGENT_CANDIDATE]}
            status="ready"
            onOpen={jest.fn()}
            onSelect={jest.fn()}
          />,
        ),
      );
      act(() => byTestId('ledger-owner-picker').click());
      expect(
        allByTestId('ledger-owner-option')[0]?.getAttribute('aria-checked'),
      ).toBe('true');
      act(() => byTestId('ledger-owner-picker').click());
    }
  });

  it('offers You while the other owners load', () => {
    act(() =>
      root.render(
        <LedgerOwnerPicker
          ownerName="Parser fixes"
          ownerActorId={CHAT.actorId}
          candidates={[]}
          status="loading"
          onOpen={jest.fn()}
          onSelect={jest.fn()}
        />,
      ),
    );
    act(() => byTestId('ledger-owner-picker').click());

    expect(byTestId('ledger-owner-option-you')).toBeDefined();
    expect(byTestId('ledger-owner-loading').textContent).toBe(
      'Loading owners…',
    );
  });
});

describe('LedgerFileSearch', () => {
  it('lists matching files with their root, and picks one', () => {
    const onPick = jest.fn();
    const file: LedgerViewFileCandidate = {
      rootId: 'repo-1',
      rootName: 'canopy',
      path: 'src/a.ts',
    };
    act(() =>
      root.render(
        <LedgerFileSearch
          query="a.ts"
          onQueryChange={jest.fn()}
          results={[file]}
          searching={false}
          onPick={onPick}
        />,
      ),
    );

    const result = byTestId('ledger-file-search-result');
    expect(result.textContent).toBe('src/a.tscanopy');
    act(() => result.click());
    expect(onPick).toHaveBeenCalledWith(file);
  });
});
