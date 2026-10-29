import {
  getAllSteps,
  getJobOrder,
  type Pipeline,
} from '@canopy/desktop-shared/types/pipeline';

describe('pipeline helpers', () => {
  it('flattens steps across all jobs in declaration order', () => {
    const pipeline: Pipeline = {
      name: 'Test Pipeline',
      on: 'dispatch',
      jobs: {
        discovery: {
          steps: [{ id: 'discover' }, { id: 'requirements' }],
        },
        implementation: {
          needs: 'discovery',
          steps: [{ id: 'code' }],
        },
      },
    };

    expect(getAllSteps(pipeline)).toEqual([
      { id: 'discover' },
      { id: 'requirements' },
      { id: 'code' },
    ]);
  });

  it('sorts jobs topologically from needs dependencies', () => {
    const pipeline: Pipeline = {
      name: 'Test Pipeline',
      on: 'dispatch',
      jobs: {
        deploy: {
          needs: ['build', 'test'],
          steps: [],
        },
        build: {
          needs: 'setup',
          steps: [],
        },
        setup: {
          steps: [],
        },
        test: {
          needs: 'build',
          steps: [],
        },
      },
    };

    expect(getJobOrder(pipeline)).toEqual(['setup', 'build', 'test', 'deploy']);
  });

  it('throws on unknown dependencies', () => {
    const pipeline: Pipeline = {
      name: 'Broken Pipeline',
      on: 'dispatch',
      jobs: {
        build: {
          needs: 'missing',
          steps: [],
        },
      },
    };

    expect(() => getJobOrder(pipeline)).toThrow(
      /Unknown job dependency "missing"/,
    );
  });

  it('throws when jobs contain a cycle', () => {
    const pipeline: Pipeline = {
      name: 'Cyclic Pipeline',
      on: 'dispatch',
      jobs: {
        first: {
          needs: 'second',
          steps: [],
        },
        second: {
          needs: 'first',
          steps: [],
        },
      },
    };

    expect(() => getJobOrder(pipeline)).toThrow(
      /Cycle detected in pipeline jobs at "first"/,
    );
  });
});
