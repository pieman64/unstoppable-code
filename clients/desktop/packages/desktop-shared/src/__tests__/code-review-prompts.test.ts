import {
  REVIEW_ANNOTATIONS_JSON_SCHEMA,
  buildCodeReviewDiagramUserPrompt,
  buildReviewAnnotationsSystemPrompt,
  buildReviewDataModelDiffSystemPrompt,
  buildReviewLogicDiffSystemPrompt,
} from '../lib/code-review-prompts';
import { buildCodeReviewPrompt } from '../lib/code-review-prompt';

describe('code-review prompts', () => {
  it('user prompt embeds the diff bundle', () => {
    const prompt = buildCodeReviewDiagramUserPrompt('DIFF-CONTENT');
    expect(prompt).toContain('# Branch changes');
    expect(prompt).toContain('DIFF-CONTENT');
  });

  it('annotation system prompt embeds its schema and constraints', () => {
    const prompt = buildReviewAnnotationsSystemPrompt();
    expect(prompt).toContain('ONLY JSON');
    expect(prompt).toContain(JSON.stringify(REVIEW_ANNOTATIONS_JSON_SCHEMA));
    expect(prompt).toContain('at most 20');
  });

  it('diagram prompts embed the reused schemas and diff framing', () => {
    expect(buildReviewLogicDiffSystemPrompt()).toContain('merge-base');
    expect(buildReviewDataModelDiffSystemPrompt()).toContain(
      'applicable: false',
    );
  });

  it('chat prompt names the review tools', () => {
    const prompt = buildCodeReviewPrompt();
    expect(prompt).toContain('RespondToComment');
    expect(prompt).toContain('GetReviewComments');
  });

  it('chat prompt treats ambiguous comments as questions', () => {
    const prompt = buildCodeReviewPrompt();
    expect(prompt).toContain('Comments may simply be questions');
    expect(prompt).toContain('do not assume changes are requested');
  });
});
