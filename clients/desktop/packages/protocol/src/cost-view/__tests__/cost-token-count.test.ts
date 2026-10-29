import { costTokenCount, type CostTokenTotals } from '..';

describe('costTokenCount', () => {
  it('includes cached input tokens without adding reasoning twice', () => {
    const tokens: CostTokenTotals = {
      input: 90,
      output: 92_975,
      cacheReadInputTokens: 10_848_711,
      cacheCreationInputTokens: 351_582,
      reasoningOutputTokens: 80_000_000,
    };

    expect(costTokenCount(tokens)).toBe(11_293_358);
  });
});
