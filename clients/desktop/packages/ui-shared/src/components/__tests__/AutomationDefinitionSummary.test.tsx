import { renderToString } from 'react-dom/server';
import { CHAT_LABEL, WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import type { SharedAutomationDocument } from '@canopy/protocol/automations';
import {
  AUTOMATION_PACKAGE_BUNDLED_NOTE,
  AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE,
} from '../../lib/pipeline-package-display';
import {
  AUTOMATION_TARGET_NONE_LABEL,
  AUTOMATION_TARGET_UNVERIFIED_NOTE,
  AutomationDefinitionSummary,
  describeAutomationTargetRequirement,
} from '../AutomationDefinitionSummary';

const base: SharedAutomationDocument = {
  version: 1,
  name: 'Nightly triage',
  description: '',
  trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
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
  hasRunCondition: true,
};

describe('AutomationDefinitionSummary', (): void => {
  it('renders the action, plugins, and the run-condition note', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary automation={base} />,
    );
    expect(html).toContain('Sends a prompt to Orchestrator');
    expect(html).toContain('Triage the inbox.');
    expect(html).toContain('commit-messages');
    expect(html).toContain('run condition');
  });

  it('points a v4 run condition at install review without rendering the command', (): void => {
    const command = 'test -f ~/.config/capacity-ok';
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{ ...base, version: 4, runCondition: { command } }}
      />,
    );
    expect(html).toContain(
      'The author gated this with a run condition you can review when installing.',
    );
    expect(html).not.toContain('stays on their machine');
    expect(html).not.toContain('capacity-ok');
  });

  it('keeps the stays-on-their-machine note when the command was not shared', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary automation={base} />,
    );
    expect(html).toContain('the command stays on their machine');
    expect(html).not.toContain('review when installing');
  });

  it('renders pipeline actions with input keys and no prompt', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          hasRunCondition: false,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'bundled',
              pipelineId: 'code-review',
              name: 'Code Review',
            },
            inputKeys: ['branch', 'ticket'],
          },
        }}
      />,
    );
    expect(html).toContain('Runs the Code Review workflow');
    expect(html).toContain('branch');
    expect(html).toContain('ticket');
    expect(html).not.toContain('run condition');
  });

  it('never shows a pipeline identifier when the pipeline has no name', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'bundled',
              pipelineId: 'code-review-internal-id',
            },
            inputKeys: [],
          },
        }}
      />,
    );
    expect(html).toContain('Runs a workflow');
    expect(html).not.toContain('code-review-internal-id');
  });

  it('ignores an empty pipeline name', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'bundled',
              pipelineId: 'code-review-internal-id',
              name: '',
            },
            inputKeys: [],
          },
        }}
      />,
    );
    expect(html).toContain('Runs a workflow');
    expect(html).not.toContain('Runs the  workflow');
  });

  it.each([true, false])(
    'hides interface identifiers with planMode %s',
    (planMode): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={{
            ...base,
            action: {
              type: 'worktree_prompt',
              target: { kind: 'workspace' },
              prompt: 'Triage the inbox.',
              plugins: [],
              interfaceMode: 'canopy',
              planMode,
            },
          }}
        />,
      );
      expect(html).not.toContain('canopy');
      expect(html).not.toContain('Uses the');
      expect(html.includes('Starts in plan mode.')).toBe(planMode);
    },
  );

  // The installer chooses their own schedule, so the author's trigger is not
  // theirs to act on. Asserted for both trigger kinds because each used to
  // render its own branch, with its own timezone note.
  it.each([
    ['cron', base.trigger],
    [
      'one_time',
      {
        kind: 'one_time' as const,
        runAt: '2026-10-01T09:00:00.000Z',
        timezone: 'local' as const,
      },
    ],
  ])('renders no schedule for a %s trigger', (_kind, trigger): void => {
    const html = renderToString(
      <AutomationDefinitionSummary automation={{ ...base, trigger }} />,
    );
    expect(html).not.toContain('automation-summary-schedule');
    expect(html).not.toContain('When it runs');
    expect(html).not.toContain('0 2 * * *');
    expect(html).not.toContain('Every day at 02:00');
    expect(html).not.toContain('Oct 1, 2026');
    expect(html).not.toContain('Time shown in UTC.');
    expect(html).not.toContain(
      'Runs on the local clock of whoever installs it.',
    );
  });
});

describe('AutomationDefinitionSummary portable downgrades', (): void => {
  it('labels a Cowork prompt and still shows its prompt and plugins', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          hasRunCondition: false,
          action: {
            type: 'standalone_prompt',
            target: { kind: 'cowork' },
            prompt: 'Summarize today.',
            plugins: [
              {
                type: 'skill',
                source: { type: 'builtin', id: 'app' },
                skill_name: 'commit-messages',
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain(`${CHAT_LABEL} project the installer picks`);
    expect(html).toContain('Summarize today.');
    expect(html).toContain('commit-messages');
  });

  it('reads an unresolved pipeline ref as one the installer chooses', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          hasRunCondition: false,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'unresolved', name: 'Nightly review' },
            inputKeys: [],
          },
        }}
      />,
    );
    expect(html).toContain('Runs a workflow you choose');
    expect(html).toContain('Nightly review');
  });

  it('never presents an unresolved ref as though the named pipeline travels', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          hasRunCondition: false,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'unresolved' },
            inputKeys: [],
          },
        }}
      />,
    );
    expect(html).toContain('Runs a workflow you choose');
    expect(html).not.toContain('Runs the ');
  });

  it('lists the pipelines a prompt automation carries in its package', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          version: 5,
          hasRunCondition: false,
          action: {
            type: 'standalone_prompt',
            target: { kind: 'cowork' },
            prompt: 'Run 3f2504e0-4f89-41d3-9a0c-0305e82c3301 today.',
            plugins: [],
            pipelineDependencies: [
              {
                key: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
                pipeline: {
                  source: 'packaged',
                  key: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
                  pipelineContentHash: 'a'.repeat(64),
                  name: 'Journey specialist',
                },
                promptSpans: [
                  {
                    textStart: 4,
                    text: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
                  },
                ],
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('automation-summary-pipelines');
    expect(html).toContain('Journey specialist');
    expect(html).toContain('Pipelines included');
  });

  it('reads a packaged action pipeline as one that travels with the share', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          version: 5,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'packaged',
              key: 'action',
              pipelineContentHash: 'b'.repeat(64),
            },
            inputKeys: [],
          },
        }}
      />,
    );
    expect(html).toContain('Runs the workflow included in this share');
    expect(html).toContain(AUTOMATION_PACKAGE_BUNDLED_NOTE);
  });

  it('names a curated pipeline by its catalog name', (): void => {
    const html = renderToString(
      <AutomationDefinitionSummary
        automation={{
          ...base,
          hasRunCondition: false,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'curated',
              curatedKey: 'review/default',
              name: 'Review',
            },
            inputKeys: [],
          },
        }}
      />,
    );
    expect(html).toContain('Runs the Review workflow');
    expect(html).not.toContain('review/default');
  });
  describe('bundling disclosure (CAN-3135)', (): void => {
    const pipelineAutomation = (
      pipeline: Extract<
        SharedAutomationDocument['action'],
        { type: 'worktree_pipeline' }
      >['pipeline'],
    ): SharedAutomationDocument => ({
      ...base,
      hasRunCondition: false,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline,
        inputKeys: [],
      },
    });

    it('says an inline pipeline definition travels with the share', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={pipelineAutomation({
            source: 'inline',
            name: 'Nightly review',
            rawPipeline: 'name: Nightly review\n',
            pipelineContentHash: 'a'.repeat(64),
          })}
        />,
      );
      expect(html).toContain('Runs the Nightly review workflow');
      expect(html).toContain(AUTOMATION_PACKAGE_BUNDLED_NOTE);
      expect(html).not.toContain(AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE);
    });

    it('labels an unnamed inline pipeline without rendering an empty name', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={pipelineAutomation({
            source: 'inline',
            rawPipeline: 'jobs: {}\n',
            pipelineContentHash: 'b'.repeat(64),
          })}
        />,
      );
      expect(html).toContain('Runs the workflow included in this share');
      expect(html).not.toContain('Runs the  workflow');
      expect(html).not.toContain('Runs a shared workflow');
      expect(html).toContain(AUTOMATION_PACKAGE_BUNDLED_NOTE);
    });

    it('says a legacy shared pipeline ref is not included', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={pipelineAutomation({
            source: 'shared',
            remoteId: '11111111-1111-4111-8111-111111111111',
            name: 'Nightly review',
          })}
        />,
      );
      expect(html).toContain(AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE);
      expect(html).not.toContain(AUTOMATION_PACKAGE_BUNDLED_NOTE);
    });

    it('leaves bundled, curated, and unresolved refs undisclosed', (): void => {
      for (const pipeline of [
        { source: 'bundled' as const, pipelineId: 'code-review' },
        { source: 'curated' as const, curatedKey: 'review/default' },
        { source: 'unresolved' as const },
      ]) {
        const html = renderToString(
          <AutomationDefinitionSummary
            automation={pipelineAutomation(pipeline)}
          />,
        );
        expect(html).not.toContain(AUTOMATION_PACKAGE_BUNDLED_NOTE);
        expect(html).not.toContain(AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE);
      }
    });
  });

  describe('distributionMode (CAN-3135)', (): void => {
    const bare: SharedAutomationDocument = {
      ...base,
      hasRunCondition: false,
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Triage the inbox.',
        plugins: [],
      },
    };

    it('renders no requirements block when the prop is omitted', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary automation={bare} />,
      );
      expect(html).not.toContain('automation-summary-needs');
      expect(html).not.toContain('automation-summary-distribution');
    });

    it('keeps output byte-identical for a full document when the prop is omitted', (): void => {
      // Desktop no-regression guard: the preview surface passes no
      // distributionMode and must render exactly what it rendered before.
      const withProp = renderToString(
        <AutomationDefinitionSummary
          automation={base}
          distributionMode={undefined}
        />,
      );
      const without = renderToString(
        <AutomationDefinitionSummary automation={base} />,
      );
      expect(withProp).toBe(without);
      expect(without).not.toContain('automation-summary-distribution');
    });

    it.each(['package', 'definition_only'] as const)(
      'hides the requirements block for a %s share that needs nothing',
      (mode): void => {
        // An empty "What it needs" only asks the reader to work out that it
        // is empty. The definition-only warning above the CTA already covers
        // the disclosure, so nothing is lost by staying silent here.
        const html = renderToString(
          <AutomationDefinitionSummary
            automation={bare}
            distributionMode={mode}
          />,
        );
        expect(html).not.toContain('automation-summary-needs');
        expect(html).not.toContain('What it needs');
        expect(html).not.toContain('automation-summary-distribution');
      },
    );

    it('still states the distribution mode when the automation needs something', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={base}
          distributionMode="definition_only"
        />,
      );
      expect(html).toContain('automation-summary-needs');
      expect(html).toContain('commit-messages');
      expect(html).toContain(
        'Required dependencies are not included in this share.',
      );
    });

    it('states an included package beside real requirements', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={base}
          distributionMode="package"
        />,
      );
      expect(html).toContain('automation-summary-needs');
      expect(html).toContain(
        'Required dependencies are included in this share.',
      );
    });
  });

  describe('target requirement (CAN-3734)', (): void => {
    const pipelineDoc: SharedAutomationDocument = {
      ...base,
      hasRunCondition: false,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: { source: 'bundled', pipelineId: 'code-review' },
        inputKeys: [],
      },
    };

    it('shows a Cowork prompt runs only in a Cowork project', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={{
            ...base,
            action: {
              type: 'standalone_prompt',
              target: { kind: 'cowork' },
              prompt: 'Check CI.',
              plugins: [],
            },
          }}
        />,
      );
      expect(html).toContain(`Runs in a ${CHAT_LABEL} project`);
      expect(html).not.toContain('code project');
      expect(html).not.toContain('automation-summary-runs-in-unverified');
    });

    it('marks an unresolved pipeline as unverified rather than effective', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary automation={pipelineDoc} />,
      );
      expect(html).toContain(
        `Runs in a ${CHAT_LABEL} project or a code project`,
      );
      expect(html).toContain('automation-summary-runs-in-unverified');
      expect(html).toContain(AUTOMATION_TARGET_UNVERIFIED_NOTE.slice(0, 20));
    });

    it('applies a declared narrowing and host-resolved contexts', (): void => {
      const narrowed: SharedAutomationDocument = {
        ...pipelineDoc,
        version: 3,
        targetRequirement: { contexts: ['worktree'] },
      };
      expect(describeAutomationTargetRequirement(narrowed)).toEqual({
        contexts: ['worktree'],
        verified: false,
      });
      expect(
        describeAutomationTargetRequirement(pipelineDoc, ['worktree']),
      ).toEqual({ contexts: ['worktree'], verified: true });
      expect(describeAutomationTargetRequirement(narrowed, ['cowork'])).toEqual(
        { contexts: [], verified: true },
      );
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={narrowed}
          resolvedTargetContexts={['cowork', 'worktree']}
        />,
      );
      expect(html).toContain('Runs in a code project');
      expect(html).not.toContain('automation-summary-runs-in-unverified');
    });

    it('describes App Advisor prompts without a project', (): void => {
      expect(describeAutomationTargetRequirement(base)).toEqual({
        contexts: ['app_advisor'],
        verified: true,
      });
    });
  });

  describe('pipeline destinations', (): void => {
    const pipelineDocument = (
      kind: 'workspace' | 'global' | 'new_worktree' | 'task' | 'project',
    ): SharedAutomationDocument => ({
      ...base,
      version: kind === 'workspace' ? 1 : 5,
      action: {
        type: 'worktree_pipeline',
        target: { kind },
        pipeline: { source: 'bundled', pipelineId: 'review', name: 'Review' },
        inputKeys: [],
      },
    });

    it.each([
      ['global', 'Runs with no project.'],
      [
        'new_worktree',
        `Creates a new ${WORKTREE_UNIT_LABEL.toLowerCase()} each run.`,
      ],
      ['task', 'Runs in an existing task.'],
      ['project', 'Runs in the project folder.'],
    ] as const)('names the %s destination', (kind, label): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={pipelineDocument(kind)}
          resolvedTargetContexts={[]}
        />,
      );
      expect(html).toContain(label);
      expect(html).not.toContain(AUTOMATION_TARGET_NONE_LABEL);
      expect(html).not.toContain('Runs in a code project');
    });

    it('keeps the Runs in contexts for the legacy workspace kind', (): void => {
      const html = renderToString(
        <AutomationDefinitionSummary
          automation={pipelineDocument('workspace')}
        />,
      );
      expect(html).toContain('Runs in');
      expect(html).toContain(AUTOMATION_TARGET_UNVERIFIED_NOTE);
      expect(html).not.toContain('automation-summary-destination');
    });
  });
});
