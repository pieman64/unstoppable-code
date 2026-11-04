/**
 * CAN-4551: the converted pipelines the Electron parity flow
 * (`chat-automation-conversion.spec.mjs`) runs are the converter's own
 * output, so that flow compares native and converted runs of the current
 * converter, not of a stale copy.
 *
 * Intended deltas from the native action, which the flow does not compare:
 * - the run records `pipelineExecutionId` as well as the chat it sent to;
 * - a new worktree the run created stays when the send then fails;
 * - an agent's automation keeps its admission through the pipeline's agent
 *   author (D11) instead of the activity's;
 * - a scheduled Cowork or Orchestrator run sends in the background, as a
 *   scheduled worktree run does, where the native action always sent in the
 *   foreground;
 * - the reply wait is capped at 720 minutes;
 * - an Orchestrator entry keeps the title it was converted with after the
 *   automation is renamed.
 *
 * The CAN-5479 cases (`*_selections`, `*_expressions`, `*_composer`,
 * `*_agent`) cover what used to stay native: local plugin selections and Ultra
 * fast, expressions in a title with a group named None, an attachment with
 * voice input, and an Agent through the pipeline's model alias.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  chatAutomationToPipeline,
  ownedPipelineToChatAction,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { PipelineAgentModelAliasPreference } from '@canopy/desktop-shared/types/pipeline';

const FIXTURE = path.resolve(
  __dirname,
  '../../../../tests/electron/fixtures/converted-chat-automations.json',
);

interface FixtureCase {
  activity: Pick<ScheduledActivity, 'name' | 'action'>;
  pipeline: unknown;
  inputs: Record<string, string>;
  modelAliasPreferences?: Record<string, PipelineAgentModelAliasPreference>;
}

function fixtureCases(): Array<[string, FixtureCase]> {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('The parity fixture is not an object.');
  return Object.entries(parsed).map(([key, value]: [string, FixtureCase]) => [
    key,
    value,
  ]);
}

describe('converted chat automation parity fixture', () => {
  it('covers every chat action the flow compares', () => {
    expect(fixtureCases().map(([key]) => key)).toEqual([
      'cowork',
      'cowork_selections',
      'orchestrator',
      'orchestrator_expressions',
      'session',
      'session_composer',
      'worktree',
      'worktree_agent',
    ]);
  });

  it.each(fixtureCases())(
    'holds the converter output for the %s case',
    (_key, { activity, pipeline, inputs, modelAliasPreferences }) => {
      expect(chatAutomationToPipeline(activity)).toEqual({
        pipeline,
        inputs,
        ...(modelAliasPreferences ? { modelAliasPreferences } : {}),
      });
    },
  );

  it.each(fixtureCases())(
    'maps the %s case back to its native action',
    (_key, { activity }) => {
      const converted = chatAutomationToPipeline(activity);
      expect(
        ownedPipelineToChatAction(
          converted.pipeline,
          converted.inputs,
          () => activity.action.type === 'standalone_prompt',
          converted.modelAliasPreferences,
        ),
      ).toEqual(activity.action);
    },
  );
});
