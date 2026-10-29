import {
  getTriggerInputDefs,
  getTriggerTypes,
  setTriggerTypes,
  type PipelineInputDef,
  type PipelineTrigger,
  type PipelineTriggerConfig,
} from '../types/pipeline';

function expectTriggerConfig(result: PipelineTrigger): PipelineTriggerConfig {
  if (typeof result === 'string') {
    throw new Error('Expected trigger config object');
  }

  return result;
}

describe('getTriggerTypes', () => {
  it('returns dispatch for null/undefined', () => {
    expect(getTriggerTypes(null)).toEqual(['dispatch']);
    expect(getTriggerTypes(undefined)).toEqual(['dispatch']);
  });

  it('returns the type for string triggers', () => {
    expect(getTriggerTypes('dispatch')).toEqual(['dispatch']);
    expect(getTriggerTypes('plan_ready')).toEqual(['plan_ready']);
    expect(getTriggerTypes('task_ready')).toEqual(['task_ready']);
  });

  it('returns types from config objects', () => {
    expect(getTriggerTypes({ dispatch: {} })).toEqual(['dispatch']);
    expect(getTriggerTypes({ plan_ready: {} })).toEqual(['plan_ready']);
    expect(getTriggerTypes({ task_ready: {} })).toEqual(['task_ready']);
    expect(getTriggerTypes({ dispatch: {}, plan_ready: {} })).toEqual([
      'dispatch',
      'plan_ready',
    ]);
    expect(
      getTriggerTypes({ dispatch: {}, plan_ready: {}, task_ready: {} }),
    ).toEqual(['dispatch', 'plan_ready', 'task_ready']);
  });
});

describe('getTriggerInputDefs', () => {
  it('returns undefined for null/undefined triggers', () => {
    expect(getTriggerInputDefs(null, 'dispatch')).toBeUndefined();
    expect(getTriggerInputDefs(undefined, 'plan_ready')).toBeUndefined();
    expect(getTriggerInputDefs(undefined, 'task_ready')).toBeUndefined();
  });

  it('returns undefined for string triggers', () => {
    expect(getTriggerInputDefs('dispatch', 'dispatch')).toBeUndefined();
    expect(getTriggerInputDefs('plan_ready', 'plan_ready')).toBeUndefined();
    expect(getTriggerInputDefs('task_ready', 'task_ready')).toBeUndefined();
  });

  it('returns undefined when trigger type is not present', () => {
    expect(getTriggerInputDefs({ dispatch: {} }, 'plan_ready')).toBeUndefined();
    expect(getTriggerInputDefs({ plan_ready: {} }, 'dispatch')).toBeUndefined();
    expect(getTriggerInputDefs({ task_ready: {} }, 'dispatch')).toBeUndefined();
  });

  it('returns undefined when trigger has no inputs', () => {
    expect(getTriggerInputDefs({ dispatch: {} }, 'dispatch')).toBeUndefined();
    expect(
      getTriggerInputDefs({ plan_ready: {} }, 'plan_ready'),
    ).toBeUndefined();
    expect(
      getTriggerInputDefs({ task_ready: {} }, 'task_ready'),
    ).toBeUndefined();
  });

  it('returns dispatch inputs', () => {
    const inputs: Record<string, PipelineInputDef> = {
      greeting: { type: 'string', required: true },
    };
    const trigger: PipelineTriggerConfig = {
      dispatch: { inputs },
    };
    expect(getTriggerInputDefs(trigger, 'dispatch')).toBe(inputs);
  });

  it('returns plan_ready inputs', () => {
    const inputs: Record<string, PipelineInputDef> = {
      auto_approve: { type: 'boolean', default: true },
    };
    const trigger: PipelineTriggerConfig = {
      plan_ready: { inputs },
    };
    expect(getTriggerInputDefs(trigger, 'plan_ready')).toBe(inputs);
  });

  it('returns correct inputs from mixed triggers', () => {
    const dispatchInputs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
    };
    const planReadyInputs: Record<string, PipelineInputDef> = {
      strategy: { type: 'choice', options: ['fast', 'safe'] },
    };
    const trigger: PipelineTriggerConfig = {
      dispatch: { inputs: dispatchInputs },
      plan_ready: { inputs: planReadyInputs },
    };
    expect(getTriggerInputDefs(trigger, 'dispatch')).toBe(dispatchInputs);
    expect(getTriggerInputDefs(trigger, 'plan_ready')).toBe(planReadyInputs);
  });

  it('returns task_ready inputs', () => {
    const inputs: Record<string, PipelineInputDef> = {
      strategy: { type: 'choice', options: ['outline', 'deep'] },
    };
    const trigger: PipelineTriggerConfig = {
      task_ready: { inputs },
    };
    expect(getTriggerInputDefs(trigger, 'task_ready')).toBe(inputs);
  });
});

describe('setTriggerTypes', () => {
  describe('single-trigger path', () => {
    it('collapses empty plan_ready to string shorthand', () => {
      const result = setTriggerTypes('dispatch', ['plan_ready']);
      expect(result).toBe('plan_ready');
    });

    it('collapses plan_ready with empty config to string shorthand', () => {
      const result = setTriggerTypes({ plan_ready: {} }, ['plan_ready']);
      expect(result).toBe('plan_ready');
    });

    it('preserves plan_ready.inputs in single-trigger path', () => {
      const inputs: Record<string, PipelineInputDef> = {
        auto_approve: { type: 'boolean', default: false },
      };
      const current: PipelineTrigger = {
        dispatch: {},
        plan_ready: { inputs },
      };
      const result = setTriggerTypes(current, ['plan_ready']);

      expect(typeof result).toBe('object');
      expect(result).not.toBe('plan_ready');
      const config = expectTriggerConfig(result);
      expect(config.plan_ready?.inputs).toBe(inputs);
      expect(config.dispatch).toBeUndefined();
    });

    it('collapses dispatch to string shorthand when no inputs', () => {
      const result = setTriggerTypes('plan_ready', ['dispatch']);
      expect(result).toBe('dispatch');
    });

    it('collapses task_ready with empty config to string shorthand', () => {
      const result = setTriggerTypes({ task_ready: {} }, ['task_ready']);
      expect(result).toBe('task_ready');
    });

    it('preserves task_ready.inputs in single-trigger path', () => {
      const inputs: Record<string, PipelineInputDef> = {
        audience: { type: 'string', default: 'engineer' },
      };
      const current: PipelineTrigger = {
        dispatch: {},
        task_ready: { inputs },
      };
      const result = setTriggerTypes(current, ['task_ready']);

      expect(typeof result).toBe('object');
      expect(result).not.toBe('task_ready');
      const config = expectTriggerConfig(result);
      expect(config.task_ready?.inputs).toBe(inputs);
      expect(config.dispatch).toBeUndefined();
    });

    it('preserves dispatch.inputs in single-trigger path', () => {
      const inputs: Record<string, PipelineInputDef> = {
        greeting: { type: 'string', required: true },
      };
      const current: PipelineTrigger = {
        dispatch: { inputs },
      };
      const result = setTriggerTypes(current, ['dispatch']);
      expect(typeof result).toBe('object');
    });
  });

  describe('multi-trigger path', () => {
    it('preserves plan_ready.inputs when building multi-trigger config', () => {
      const planReadyInputs: Record<string, PipelineInputDef> = {
        strategy: { type: 'choice', options: ['fast', 'safe'] },
      };
      const current: PipelineTrigger = {
        plan_ready: { inputs: planReadyInputs },
      };
      const result = setTriggerTypes(current, ['dispatch', 'plan_ready']);

      const config = expectTriggerConfig(result);
      expect(config.dispatch).toEqual({});
      expect(config.plan_ready?.inputs).toBe(planReadyInputs);
    });

    it('preserves both dispatch and plan_ready configs', () => {
      const dispatchInputs: Record<string, PipelineInputDef> = {
        name: { type: 'string' },
      };
      const planReadyInputs: Record<string, PipelineInputDef> = {
        auto_approve: { type: 'boolean', default: true },
      };
      const current: PipelineTrigger = {
        dispatch: { inputs: dispatchInputs },
        plan_ready: { inputs: planReadyInputs },
      };
      const result = setTriggerTypes(current, ['dispatch', 'plan_ready']);

      const config = expectTriggerConfig(result);
      expect(config.dispatch?.inputs).toBe(dispatchInputs);
      expect(config.plan_ready?.inputs).toBe(planReadyInputs);
    });

    it('defaults plan_ready to empty object when not in current', () => {
      const result = setTriggerTypes('dispatch', ['dispatch', 'plan_ready']);
      const config = expectTriggerConfig(result);
      expect(config.plan_ready).toEqual({});
    });

    it('defaults dispatch to empty object when not in current', () => {
      const result = setTriggerTypes('plan_ready', ['dispatch', 'plan_ready']);
      const config = expectTriggerConfig(result);
      expect(config.dispatch).toEqual({});
    });

    it('preserves task_ready inputs in multi-trigger configs', () => {
      const taskReadyInputs: Record<string, PipelineInputDef> = {
        audience: { type: 'string', default: 'engineer' },
      };
      const current: PipelineTrigger = {
        task_ready: { inputs: taskReadyInputs },
      };
      const result = setTriggerTypes(current, ['dispatch', 'task_ready']);

      const config = expectTriggerConfig(result);
      expect(config.dispatch).toEqual({});
      expect(config.task_ready?.inputs).toBe(taskReadyInputs);
    });
  });

  describe('edge cases', () => {
    it('returns dispatch for empty types array', () => {
      expect(setTriggerTypes('dispatch', [])).toBe('dispatch');
    });

    it('deduplicates types', () => {
      const result = setTriggerTypes('dispatch', ['plan_ready', 'plan_ready']);
      expect(result).toBe('plan_ready');
    });
  });
});
