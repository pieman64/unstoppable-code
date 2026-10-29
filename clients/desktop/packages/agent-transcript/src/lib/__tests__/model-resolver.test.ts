import { resolveRuntimeModel } from '../model-resolver';

describe('model-resolver', () => {
  it('does not report runtime model metadata without a host resolver', () => {
    expect(resolveRuntimeModel('claude-opus-4-8')).toBeUndefined();
  });
});
