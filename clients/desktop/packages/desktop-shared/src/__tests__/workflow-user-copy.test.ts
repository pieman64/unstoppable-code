import {
  AUTOMATION_SHARE_BLOCK_MESSAGES,
  AUTOMATION_SHARE_NOTICE_MESSAGES,
} from '../lib/automation-sharing';
import { LABS_EXPERIMENTS } from '../lib/labs-experiments';
import { pipelineHookUnsupportedSpeedError } from '../hooks';
import { PIPELINE_PACKAGE_SETUP_REQUIRED_REMOTE_MESSAGE } from '../pipelines/package-readiness';
import { SPLIT_PR_BLOCKER_COPY } from '../types/github';
import { createDefaultPipeline } from '../types/pipeline';

// Copy minted here and rendered by the desktop renderer, Electron main,
// Remote Control or the CLI calls the item a workflow (CAN-4651). Identifiers
// and keys keep their `pipeline` names.
describe('user-visible workflow copy', () => {
  it('names workflows in the Remote Control setup refusal', () => {
    expect(PIPELINE_PACKAGE_SETUP_REQUIRED_REMOTE_MESSAGE).toBe(
      'This workflow needs setup finished in the desktop app before it can run.',
    );
  });

  it('names workflows in the split PR blocker copy', () => {
    expect(SPLIT_PR_BLOCKER_COPY.active_pipelines).toBe(
      'Wait for active workflows to finish',
    );
  });

  it('keeps active Labs descriptions free of pipeline wording', () => {
    expect(LABS_EXPERIMENTS.length).toBeGreaterThan(0);
    expect(
      LABS_EXPERIMENTS.filter((entry) =>
        /\bpipelines?\b/i.test(entry.description),
      ),
    ).toEqual([]);
  });

  it('names a new workflow draft', () => {
    expect(createDefaultPipeline().name).toBe('New workflow');
  });

  it('names workflows in the hook Ultra fast refusal', () => {
    expect(
      pipelineHookUnsupportedSpeedError({
        modelConfig: { speed: 'ultrafast', fastMode: false },
      }),
    ).toBe('Workflow hooks do not support Ultra fast. Choose Regular or Fast.');
  });

  it('never says pipeline in automation share messages', () => {
    const messages = [
      ...Object.values(AUTOMATION_SHARE_BLOCK_MESSAGES),
      ...Object.values(AUTOMATION_SHARE_NOTICE_MESSAGES),
    ];
    expect(messages.filter((message) => /pipeline/i.test(message))).toEqual([]);
  });
});
