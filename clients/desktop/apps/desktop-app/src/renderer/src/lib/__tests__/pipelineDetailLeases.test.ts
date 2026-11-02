import {
  acquirePipelineDetailLease,
  acquirePipelineSummaryInterest,
  releasePipelineDetailLease,
  resetPipelineDetailLeasesForTests,
  subscribePipelineInterestChanges,
} from '../pipelineDetailLeases';

describe('pipeline detail interest changes', () => {
  beforeEach(() => {
    resetPipelineDetailLeasesForTests();
  });

  it('notifies on the final lease and final summary-interest release', () => {
    const changes: string[] = [];
    const unsubscribe = subscribePipelineInterestChanges((executionId) => {
      changes.push(executionId);
    });
    const leaseA = acquirePipelineDetailLease(null, 'execution-1');
    const leaseB = acquirePipelineDetailLease(null, 'execution-1');
    const releaseInterestA = acquirePipelineSummaryInterest('execution-1');
    const releaseInterestB = acquirePipelineSummaryInterest('execution-1');

    expect(releasePipelineDetailLease(leaseA)).toBe(false);
    expect(changes).toEqual([]);
    expect(releasePipelineDetailLease(leaseB)).toBe(true);
    expect(changes).toEqual(['execution-1']);

    releaseInterestA();
    expect(changes).toEqual(['execution-1']);
    releaseInterestB();
    expect(changes).toEqual(['execution-1', 'execution-1']);

    unsubscribe();
  });
});
