import type { SharedAutomationDocument } from '../../automations';
import {
  AUTOMATION_CATALOG_API_VERSION,
  isCuratedAutomationDetail,
  isCuratedAutomationListResponse,
  isCuratedAutomationSummary,
  toCuratedAutomationInstallSource,
  type CuratedAutomationDetail,
} from '..';

function automation(): SharedAutomationDocument {
  return {
    version: 1,
    name: 'Daily review',
    description: 'Review open work',
    trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Review', plugins: [] },
    hasRunCondition: false,
  };
}

function detail(): CuratedAutomationDetail {
  return {
    key: 'daily-review',
    name: 'Daily review',
    shortDescription: 'Review open work',
    icon: '',
    triggerKind: 'cron',
    cronExpression: '0 9 * * *',
    actionType: 'app_advisor_prompt',
    pipelineSource: null,
    referencedCuratedPipelineKey: null,
    pluginCount: 0,
    contentHash: 'a'.repeat(64),
    contentSizeBytes: 200,
    categories: ['review'],
    popular: false,
    sortOrder: 0,
    revision: 1,
    authorName: null,
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z',
    automation: automation(),
  };
}

describe('automation catalog contract', () => {
  it('validates summaries, details, and list envelopes', () => {
    const value = detail();
    expect(isCuratedAutomationSummary(value)).toBe(true);
    expect(isCuratedAutomationDetail(value)).toBe(true);
    expect(
      isCuratedAutomationListResponse({
        version: AUTOMATION_CATALOG_API_VERSION,
        data: [value],
        nextCursor: null,
      }),
    ).toBe(true);
  });

  it('rejects non-cron and malformed Automation documents', () => {
    expect(
      isCuratedAutomationSummary({ ...detail(), triggerKind: 'one_time' }),
    ).toBe(false);
    expect(
      isCuratedAutomationDetail({ ...detail(), automation: { name: 'bad' } }),
    ).toBe(false);
  });

  it('projects the existing install-wizard source shape', () => {
    const value = detail();
    expect(toCuratedAutomationInstallSource(value)).toEqual({
      id: value.key,
      contentHash: value.contentHash,
      automation: value.automation,
    });
  });
});
