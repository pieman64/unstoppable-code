/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LedgerActorRef,
  LedgerOwnerCandidate,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewFileCandidate } from '@canopy/protocol/ledger-view';
import { SubagentIcon } from '../../chat/subagents/common/SubagentIcon';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import { LedgerActorAvatar } from '../LedgerActorAvatar';
import { LedgerComposerPrompt } from '../LedgerComposerPrompt';
import {
  LedgerCorrectionBox,
  type LedgerCorrectionBoxProps,
} from '../LedgerCorrectionBox';
import { LedgerEntryForm, type LedgerEntryFormValue } from '../LedgerEntryForm';
import { LedgerFileSearch } from '../LedgerFileSearch';
import { LedgerOwnerPicker } from '../LedgerOwnerPicker';
import { LedgerStatusControl } from '../LedgerStatusControl';

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
const SELF_CANDIDATE: LedgerOwnerCandidate = {
  actor: YOU,
  displayName: 'You',
  eligibilityToken: 'token-you',
  isSelf: true,
};
const CHAT_CANDIDATE: LedgerOwnerCandidate = {
  actor: CHAT,
  displayName: 'Theme support',
  eligibilityToken: 'token-chat',
  isSelf: false,
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

function renderCorrection(props: Partial<LedgerCorrectionBoxProps> = {}): void {
  const defaults: LedgerCorrectionBoxProps = {
    density: 'panel',
    personName: 'Jordan Park',
    value: '',
    onChange: jest.fn(),
    onSubmit: jest.fn(),
    onDiscard: jest.fn(),
    saving: false,
    problem: null,
  };
  act(() => root.render(<LedgerCorrectionBox {...defaults} {...props} />));
}

describe('LedgerCorrectionBox', () => {
  it('shows the person writing as You: the person glyph, recorded in replay', () => {
    // Hosts pass "You", the person on this device, who has no initials.
    renderCorrection({ personName: 'You' });
    const avatar = byTestId('ledger-actor-avatar');
    expect(avatar.textContent).toBe('');
    expect(avatar.querySelector('svg')).not.toBeNull();
    expect(avatar.classList).not.toContain(REPLAY_BLOCK_CLASS);
  });

  it('shows every action and the correction hint from the start', () => {
    const onMoreOptions = jest.fn();
    renderCorrection({ onMoreOptions });

    const field = byTestId('ledger-correction-input');
    expect(field.getAttribute('placeholder')).toBe('Add a correction');
    expect(byTestId('ledger-correction-box')).toBeDefined();
    expect(byTestId('ledger-correction-more').textContent).toBe('More options');
    expect(byTestId('ledger-correction-discard').textContent).toBe('Cancel');
    expect(byTestId('ledger-correction-save').textContent).toBe(
      'Add correction',
    );
    expect(byTestId('ledger-correction-save')).toHaveProperty('disabled', true);
    expect(document.body.textContent).toContain(
      'A correction is a new entry linked to this one, which stays as it is.',
    );
    act(() => byTestId('ledger-correction-more').click());
    expect(onMoreOptions).toHaveBeenCalledTimes(1);
  });

  it('shows actions and the hint with text, and More options only when given', () => {
    const onMoreOptions = jest.fn();
    renderCorrection({ value: 'Corrected detail.', onMoreOptions });

    expect(byTestId('ledger-correction-save').textContent).toBe(
      'Add correction',
    );
    expect(byTestId('ledger-correction-discard').textContent).toBe('Cancel');
    expect(byTestId('ledger-correction-more').textContent).toBe('More options');
    expect(document.body.textContent).toContain(
      'A correction is a new entry linked to this one, which stays as it is.',
    );
    act(() => byTestId('ledger-correction-more').click());
    expect(onMoreOptions).toHaveBeenCalledTimes(1);

    renderCorrection({ value: 'Corrected detail.' });
    expect(
      document.querySelector('[data-testid="ledger-correction-more"]'),
    ).toBeNull();
  });

  it('submits a nonblank correction by button and Cmd/Ctrl+Enter', () => {
    const onSubmit = jest.fn();
    renderCorrection({ value: 'Corrected detail.', onSubmit });
    act(() => byTestId('ledger-correction-save').click());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const field = byTestId('ledger-correction-input');
    for (const modifier of ['metaKey', 'ctrlKey'] as const) {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        [modifier]: true,
      });
      act(() => {
        field.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onSubmit).toHaveBeenCalledTimes(3);
  });

  it('blocks blank and whitespace-only corrections by button and shortcut', () => {
    const onSubmit = jest.fn();
    renderCorrection({ onSubmit });
    expect(byTestId('ledger-correction-save')).toHaveProperty('disabled', true);
    act(() => byTestId('ledger-correction-save').click());
    act(() => {
      byTestId('ledger-correction-input').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();

    renderCorrection({ value: '   ', onSubmit });
    expect(byTestId('ledger-correction-save')).toHaveProperty('disabled', true);
    act(() => byTestId('ledger-correction-save').click());
    act(() => {
      byTestId('ledger-correction-input').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('focuses the correction field when it mounts', () => {
    renderCorrection();

    expect(byTestId('ledger-correction-input')).toBe(document.activeElement);
  });

  it('leaves focus where it is when it mounts again with text', () => {
    // A long list's row scrolled back into view mounts its box again.
    const elsewhere = document.createElement('textarea');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    renderCorrection({ value: 'Corrected detail.' });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('keeps the field and actions disabled while saving', () => {
    const onSubmit = jest.fn();
    renderCorrection({
      value: 'Corrected detail.',
      saving: true,
      onSubmit,
      onMoreOptions: jest.fn(),
    });

    expect(byTestId('ledger-correction-input')).toHaveProperty(
      'disabled',
      true,
    );
    expect(byTestId('ledger-correction-more')).toHaveProperty('disabled', true);
    expect(byTestId('ledger-correction-discard')).toHaveProperty(
      'disabled',
      true,
    );
    expect(byTestId('ledger-correction-save').textContent).toBe('Saving…');
    expect(byTestId('ledger-correction-save')).toHaveProperty('disabled', true);
    act(() => {
      byTestId('ledger-correction-input').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a problem as an alert and explains a disabled field', () => {
    const onSubmit = jest.fn();
    renderCorrection({
      value: 'Corrected detail.',
      problem: "Couldn't save the correction. Try again.",
      disabledReason: 'Save or discard your draft first.',
      onSubmit,
    });

    expect(byTestId('ledger-correction-problem').getAttribute('role')).toBe(
      'alert',
    );
    expect(byTestId('ledger-correction-problem').textContent).toBe(
      "Couldn't save the correction. Try again.",
    );
    const field = byTestId('ledger-correction-input');
    expect(field).toHaveProperty('disabled', true);
    expect(field.getAttribute('title')).toBe(
      'Save or discard your draft first.',
    );
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'Save or discard your draft first.',
    );
    expect(document.body.textContent).toContain(
      'Save or discard your draft first.',
    );
    expect(byTestId('ledger-correction-save')).toHaveProperty('disabled', true);
    act(() => byTestId('ledger-correction-save').click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('allows a correction at the content limit and disables it over the limit', () => {
    renderCorrection({ value: 'x'.repeat(1_000) });
    expect(byTestId('ledger-correction-save')).toHaveProperty(
      'disabled',
      false,
    );

    renderCorrection({ value: 'x'.repeat(1_001) });

    expect(byTestId('ledger-correction-save')).toHaveProperty('disabled', true);
    expect(document.body.textContent).toContain('1001/1000');
  });

  it('keeps the discard test id and calls onDiscard from Cancel', () => {
    const onDiscard = jest.fn();
    renderCorrection({ value: 'Corrected detail.', onDiscard });

    const cancel = byTestId('ledger-correction-discard');
    expect(cancel.textContent).toBe('Cancel');
    act(() => cancel.click());
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('LedgerActorAvatar', () => {
  it("shows a person's initials, the person glyph for You, and an agent's glyph", () => {
    act(() =>
      root.render(
        <LedgerActorAvatar kind="user" name="Ada Lovelace" size="small" />,
      ),
    );
    expect(byTestId('ledger-actor-avatar').textContent).toBe('AL');
    expect(byTestId('ledger-actor-avatar').querySelector('svg')).toBeNull();

    // The person on this device is "You": no initials to make from that.
    act(() =>
      root.render(
        <LedgerActorAvatar kind="user" name="You" size="large" localUser />,
      ),
    );
    const self = byTestId('ledger-actor-avatar');
    expect(self.textContent).toBe('');
    expect(self.querySelector('svg')).not.toBeNull();
    expect(self.getAttribute('style')).toContain('background-color');

    act(() =>
      root.render(
        <LedgerActorAvatar kind="chat" name="Theme support" size="small" />,
      ),
    );
    expect(byTestId('ledger-actor-avatar').querySelector('svg')).not.toBeNull();
    expect(byTestId('ledger-actor-avatar').className).toContain('bg-secondary');
  });
});

describe("LedgerActorAvatar: a delegate's glyph", () => {
  function glyphOf(kind: 'pipeline_agent' | 'managed_delegation'): string {
    act(() =>
      root.render(
        <LedgerActorAvatar kind={kind} name="Review changes" size="small" />,
      ),
    );
    const avatar = byTestId('ledger-actor-avatar');
    expect(avatar.getAttribute('data-actor-kind')).toBe(kind);
    return avatar.querySelector('svg')?.innerHTML ?? '';
  }

  it('gives a delegate the subagent glyph, never the pipeline agent glyph', () => {
    const pipeline = glyphOf('pipeline_agent');
    const delegate = glyphOf('managed_delegation');
    expect(delegate).not.toBe('');
    expect(delegate).not.toBe(pipeline);

    // The one subagent glyph, as agent cards and subagent chats show it.
    act(() => root.render(<SubagentIcon size={13} />));
    expect(container.querySelector('svg')?.innerHTML).toBe(delegate);
  });
});

describe('LedgerActorAvatar session-replay privacy', () => {
  it("blocks a teammate's initials, and records You and agent glyphs", () => {
    act(() =>
      root.render(
        <LedgerActorAvatar kind="user" name="Ada Lovelace" size="small" />,
      ),
    );
    expect(byTestId('ledger-actor-avatar').classList).toContain(
      REPLAY_BLOCK_CLASS,
    );

    act(() =>
      root.render(
        <LedgerActorAvatar kind="user" name="You" size="large" localUser />,
      ),
    );
    expect(byTestId('ledger-actor-avatar').classList).not.toContain(
      REPLAY_BLOCK_CLASS,
    );

    act(() =>
      root.render(<LedgerActorAvatar kind="user" name="You" size="small" />),
    );
    expect(byTestId('ledger-actor-avatar').classList).toContain(
      REPLAY_BLOCK_CLASS,
    );

    act(() =>
      root.render(
        <LedgerActorAvatar kind="chat" name="Theme support" size="small" />,
      ),
    );
    expect(byTestId('ledger-actor-avatar').classList).not.toContain(
      REPLAY_BLOCK_CLASS,
    );
  });
});

describe('LedgerComposerPrompt', () => {
  function renderPrompt(
    props: Partial<Parameters<typeof LedgerComposerPrompt>[0]> = {},
  ): void {
    act(() =>
      root.render(
        <LedgerComposerPrompt
          density="page"
          personName="Jordan Park"
          onOpen={jest.fn()}
          {...props}
        />,
      ),
    );
  }

  it('uses its default and custom label and opens the composer', () => {
    const onOpen = jest.fn();
    renderPrompt({ onOpen });
    expect(byTestId('ledger-composer-prompt').textContent).toBe(
      'Add a task, decision or finding',
    );
    act(() => byTestId('ledger-composer-prompt').click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    renderPrompt({ label: 'Continue draft', onOpen });
    expect(byTestId('ledger-composer-prompt').textContent).toBe(
      'Continue draft',
    );
  });

  it('shows the person writing as You: the person glyph, recorded in replay', () => {
    // Hosts pass "You", the person on this device, who has no initials.
    renderPrompt({ personName: 'You' });
    const avatar = byTestId('ledger-actor-avatar');
    expect(avatar.textContent).toBe('');
    expect(avatar.querySelector('svg')).not.toBeNull();
    expect(avatar.classList).not.toContain(REPLAY_BLOCK_CLASS);
  });

  it('takes the test id its host passes', () => {
    renderPrompt({ testId: 'ledger-add-entry' });
    expect(
      container.querySelector('[data-testid="ledger-composer-prompt"]'),
    ).toBeNull();
    expect(byTestId('ledger-add-entry').textContent).toBe(
      'Add a task, decision or finding',
    );
  });

  it('explains a disabled prompt and changes the avatar size by density', () => {
    renderPrompt({
      disabledReason: 'Open a project or task to add it.',
    });
    const prompt = byTestId('ledger-composer-prompt');
    expect(prompt).toHaveProperty('disabled', true);
    expect(prompt.getAttribute('title')).toBe(
      'Open a project or task to add it.',
    );
    const describedBy = prompt.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'Open a project or task to add it.',
    );
    expect(byTestId('ledger-actor-avatar').className).toContain('h-8');

    renderPrompt({ density: 'panel' });
    expect(byTestId('ledger-actor-avatar').className).toContain('h-6');
  });
});

describe('LedgerStatusControl inline', () => {
  it('shows the status and chevron, opens the menu, and changes status', () => {
    const onChange = jest.fn();
    act(() =>
      root.render(
        <LedgerStatusControl
          variant="inline"
          status="IN_PROGRESS"
          onChange={onChange}
        />,
      ),
    );

    const trigger = byTestId('ledger-status-control');
    expect(trigger.textContent).toContain('In progress');
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe(
      'Change status, now In progress',
    );
    act(() => trigger.click());
    expect(byTestId('ledger-status-menu')).toBeDefined();
    act(() => byTestId('ledger-status-option-blocked').click());
    expect(onChange).toHaveBeenCalledWith('BLOCKED');
  });

  it('keeps the default capsule trigger', () => {
    act(() =>
      root.render(
        <LedgerStatusControl status="IN_PROGRESS" onChange={jest.fn()} />,
      ),
    );
    const trigger = byTestId('ledger-status-control');
    expect(trigger.getAttribute('aria-label')).toBe(
      'Change status, now In progress',
    );
    expect(trigger.className).toContain('rounded-full');
    expect(trigger.className).toContain('h-8');
  });
});

describe('LedgerOwnerPicker inline', () => {
  function renderOwner(
    props: Partial<Parameters<typeof LedgerOwnerPicker>[0]> = {},
  ): void {
    act(() =>
      root.render(
        <LedgerOwnerPicker
          variant="inline"
          ownerName="Theme support"
          ownerActorId={CHAT.actorId}
          candidates={[SELF_CANDIDATE, CHAT_CANDIDATE]}
          status="ready"
          onOpen={jest.fn()}
          onSelect={jest.fn()}
          {...props}
        />,
      ),
    );
  }

  it('shows the owner, defaults its name, and lets a custom name win', () => {
    renderOwner();
    const trigger = byTestId('ledger-owner-picker');
    expect(trigger.textContent).toContain('Owner:Theme support');
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe(
      'Change owner, now Theme support',
    );
    // Its -mx-1 leaves the wrapper 0.5rem narrower: a full-width cap would
    // cut even You short.
    expect(trigger.classList.contains('-mx-1')).toBe(true);
    expect(trigger.classList.contains('max-w-[calc(100%+0.5rem)]')).toBe(true);
    expect(trigger.classList.contains('max-w-full')).toBe(false);

    renderOwner({ 'aria-label': 'Assign to someone else' });
    expect(byTestId('ledger-owner-picker').getAttribute('aria-label')).toBe(
      'Assign to someone else',
    );
  });

  it('disables the inline trigger and explains why', () => {
    renderOwner({ disabledReason: 'Save or discard your draft first.' });
    const trigger = byTestId('ledger-owner-picker');
    expect(trigger).toHaveProperty('disabled', true);
    expect(trigger.getAttribute('title')).toBe(
      'Save or discard your draft first.',
    );
  });
});

describe('LedgerEntryForm shared fields', () => {
  it('uses the shared field recipe and one button size', () => {
    const file: LedgerViewFileCandidate = {
      rootId: 'repo-1',
      rootName: 'canopy',
      path: 'src/a.ts',
    };
    act(() =>
      root.render(
        <LedgerEntryForm
          value={{
            ...BLANK,
            title: 'Ship it',
            content: 'Keep the shared fields.',
            highlights: ['Keep the field label.'],
            referenceFiles: [{ rootId: file.rootId, path: file.path }],
          }}
          correctionOf={null}
          saving={false}
          problem={null}
          fileSearch={
            <LedgerFileSearch
              query=""
              onQueryChange={jest.fn()}
              results={[file]}
              searching={false}
              onPick={jest.fn()}
            />
          }
          onChange={jest.fn()}
          onSave={jest.fn()}
          onDiscard={jest.fn()}
        />,
      ),
    );

    const fieldIds = [
      'ledger-entry-form-title',
      'ledger-entry-form-content',
      'ledger-file-search',
    ];
    for (const fieldId of fieldIds) {
      expect(byTestId(fieldId).className).toContain('shadow-field');
    }
    const highlight = document.querySelector(
      '[data-testid="ledger-entry-form-highlight"]',
    );
    expect(highlight?.className).toContain('shadow-field');
    const line = document.querySelector(
      '[aria-label="Line in src/a.ts (optional)"]',
    );
    expect(line?.className).toContain('shadow-field');

    const actionButtons = Array.from(
      container.querySelectorAll('button'),
    ).filter((button) =>
      ['Remove', 'Add highlight', 'Cancel', 'Save entry'].includes(
        button.textContent ?? '',
      ),
    );
    expect(actionButtons).toHaveLength(5);
    for (const button of actionButtons) {
      expect(button.className).toContain('h-7');
      expect(button.className).toContain('rounded-full');
      expect(button.className).toContain('text-s');
    }
  });
});
