/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see
 * ModelPicker.test.tsx); @testing-library/react is not installed.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import {
  SharedAutomationPreview,
  type SharedAutomationLocalBadge,
} from '../SharedAutomationPreview';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { outermostReplayBlock } from '@/test-utils/replay';

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

function renderPreview(
  detail: SharedAutomationDetail,
  localBadge: SharedAutomationLocalBadge | null,
): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(
      createElement(SharedAutomationPreview, { detail, localBadge }),
    );
  });
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function pipelineDetail(
  overrides: Partial<SharedAutomationDetail> = {},
): SharedAutomationDetail {
  return {
    id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
    name: 'Nightly review pipeline',
    description: 'Runs the review pipeline every night.',
    triggerKind: 'cron',
    actionType: 'worktree_pipeline',
    contentHash: 'a'.repeat(64),
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Alex', email: 'alex@example.com' },
    canUpdate: false,
    canDelete: false,
    automation: {
      version: 1,
      name: 'Nightly review pipeline',
      description: 'Runs the review pipeline every night.',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: { source: 'bundled', pipelineId: 'code-review' },
        inputKeys: ['branch', 'ticket'],
      },
      hasRunCondition: true,
    },
    ...overrides,
  };
}

describe('SharedAutomationPreview', () => {
  it('renders the pipeline document with local-time trigger, inputs, and provenance', () => {
    renderPreview(
      pipelineDetail({
        savedFrom: {
          automationId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
          contentHash: 'b'.repeat(64),
        },
      }),
      'update-available',
    );

    expect(document.body.textContent).toContain('Nightly review pipeline');
    expect(
      byTestId('shared-automation-preview-trigger')?.textContent,
    ).toContain('0 2 * * *');
    expect(byTestId('shared-automation-preview-action')?.textContent).toContain(
      'code-review',
    );
    const inputKeys = byTestId('shared-automation-preview-input-keys');
    expect(inputKeys?.textContent).toContain('branch');
    expect(inputKeys?.textContent).toContain('ticket');
    expect(byTestId('shared-automation-preview-run-condition')).not.toBeNull();
    expect(
      byTestId('shared-automation-badge-update-available')?.textContent,
    ).toBe('Update available');
    expect(byTestId('shared-automation-preview-lineage')).not.toBeNull();
    expect(document.body.textContent).toContain('Platform');
    expect(document.body.textContent).toContain('Alex');
  });

  it('says an included run-condition command is reviewed at install, without showing it', () => {
    const base = pipelineDetail();
    const command = 'test -f ~/.config/capacity-ok';
    renderPreview(
      pipelineDetail({
        automation: {
          ...base.automation,
          version: 4,
          runCondition: { command },
        },
      }),
      null,
    );

    const note = byTestId('shared-automation-preview-run-condition');
    expect(note?.textContent).toBe(
      'The author included a run-condition command. You review it when installing.',
    );
    expect(document.body.textContent).not.toContain('capacity-ok');
  });

  it('keeps the stays-on-their-machine note when the command was not shared', () => {
    renderPreview(pipelineDetail(), null);

    expect(
      byTestId('shared-automation-preview-run-condition')?.textContent,
    ).toContain('the command itself stays on their machine');
  });

  it('omits a description with no visible text', () => {
    const base = pipelineDetail();
    renderPreview(
      pipelineDetail({
        description: '---',
        automation: { ...base.automation, description: '---' },
      }),
      null,
    );
    expect(byTestId('share-description')).toBeNull();
  });

  it('renders a multi-line description as Markdown paragraphs and a list', () => {
    const description =
      'Reviews every open branch.\nPosts findings to the team.\n\n1. Checks out the branch\n2. Runs the **review** pipeline\n3. Posts a summary';
    const base = pipelineDetail();
    renderPreview(
      pipelineDetail({
        description,
        automation: { ...base.automation, description },
      }),
      null,
    );

    const rendered = byTestId('share-description');
    const paragraph = rendered?.querySelector('p');
    expect(paragraph?.querySelector('br')).not.toBeNull();
    expect(paragraph?.textContent).toBe(
      'Reviews every open branch.Posts findings to the team.',
    );
    expect(
      Array.from(
        rendered?.querySelectorAll('ol > li') ?? [],
        (item) => item.textContent,
      ),
    ).toEqual([
      'Checks out the branch',
      'Runs the review pipeline',
      'Posts a summary',
    ]);
    expect(rendered?.querySelector('strong')?.textContent).toBe('review');
    expect(rendered?.textContent).not.toContain('**');
  });

  it('renders a prompt document with plugins and a one-time local trigger', () => {
    renderPreview(
      pipelineDetail({
        triggerKind: 'one_time',
        actionType: 'app_advisor_prompt',
        automation: {
          version: 1,
          name: 'Morning triage',
          description: '',
          trigger: {
            kind: 'one_time',
            runAt: '2027-01-01T09:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Triage the inbox.',
            plugins: [
              {
                type: 'skill',
                source: { type: 'builtin', id: 'app' },
                skill_name: 'commit-messages',
              },
            ],
          },
          hasRunCondition: false,
        },
      }),
      null,
    );

    expect(
      byTestId('shared-automation-preview-trigger')?.textContent,
    ).toContain(new Date('2027-01-01T09:00:00.000Z').toLocaleString());
    expect(document.body.textContent).toContain('Triage the inbox.');
    expect(
      byTestId('shared-automation-preview-plugins')?.textContent,
    ).toContain('commit-messages');
    expect(byTestId('shared-automation-preview-run-condition')).toBeNull();
    expect(
      document.querySelector('[data-testid^="shared-automation-badge-"]'),
    ).toBeNull();
  });

  it('records the heading and blocks the prompt', () => {
    const base = pipelineDetail();
    renderPreview(pipelineDetail(), null);

    expect(
      byTestId('shared-automation-preview-heading')?.closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ),
    ).toBeNull();

    act(() => {
      root?.unmount();
    });
    renderPreview(
      pipelineDetail({
        actionType: 'app_advisor_prompt',
        automation: {
          ...base.automation,
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Summarize the acme-payments incidents.',
            plugins: [],
          },
        },
      }),
      null,
    );
    expect(byTestId('shared-automation-preview-prompt')?.classList).toContain(
      POSTHOG_REPLAY_BLOCK_CLASS,
    );
  });

  /** The value of the Settings row labeled `label`. */
  function definition(label: string): HTMLElement {
    const term = Array.from(
      document.querySelectorAll('[data-settings-row-label]'),
    ).find((row) => row.textContent === label);
    const value = term?.parentElement?.nextElementSibling;
    if (!(value instanceof HTMLElement)) throw new Error(`Missing ${label}`);
    return value;
  }

  /** The blocked descendants' texts, outermost first. */
  function blockedTexts(scope: HTMLElement): string[] {
    return Array.from(
      scope.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
      (block) => block.textContent ?? '',
    );
  }

  it("blocks the sharer's and a person owner's name, not the labels or a team owner", () => {
    renderPreview(pipelineDetail(), null);

    const sharedBy = definition('Shared by');
    expect(sharedBy.textContent).toBe('Alex');
    expect(outermostReplayBlock(sharedBy)).toBeNull();
    expect(blockedTexts(sharedBy)).toEqual(['Alex']);
    // A team owner is not a person.
    const teamOwner = definition('Owner');
    expect(teamOwner.textContent).toContain('Platform');
    expect(blockedTexts(teamOwner)).toEqual([]);

    act(() => {
      root?.unmount();
    });
    renderPreview(
      pipelineDetail({
        owner: { type: 'user', id: 'user-2', name: 'Robin' },
        createdBy: { id: 'user-2', name: null, email: 'robin@example.com' },
      }),
      null,
    );
    const personOwner = definition('Owner');
    expect(outermostReplayBlock(personOwner)).toBeNull();
    expect(blockedTexts(personOwner)).toEqual(['Robin']);
    expect(personOwner.textContent).toContain('Team');
    expect(blockedTexts(definition('Shared by'))).toEqual([
      'robin@example.com',
    ]);
  });
});
