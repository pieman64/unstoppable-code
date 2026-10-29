import { readClaudeQuotaResetsAt } from '../provider-usage-limit';

function rateLimitEvent(info: unknown): unknown {
  return { type: 'rate_limit_event', rate_limit_info: info };
}

describe('readClaudeQuotaResetsAt', () => {
  it('reads a rejected reset time reported in epoch seconds as ms', () => {
    expect(
      readClaudeQuotaResetsAt(
        rateLimitEvent({ status: 'rejected', resetsAt: 1_800_000_000 }),
      ),
    ).toBe(1_800_000_000_000);
  });

  it('passes a rejected reset time reported in ms through', () => {
    expect(
      readClaudeQuotaResetsAt(
        rateLimitEvent({ status: 'rejected', resetsAt: 1_800_000_000_000 }),
      ),
    ).toBe(1_800_000_000_000);
  });

  it('ignores warnings and other statuses', () => {
    expect(
      readClaudeQuotaResetsAt(
        rateLimitEvent({ status: 'allowed_warning', resetsAt: 1_800_000_000 }),
      ),
    ).toBeUndefined();
    expect(
      readClaudeQuotaResetsAt(
        rateLimitEvent({ status: 'allowed', resetsAt: 1_800_000_000 }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined without a usable reset time', () => {
    expect(
      readClaudeQuotaResetsAt(rateLimitEvent({ status: 'rejected' })),
    ).toBeUndefined();
    expect(
      readClaudeQuotaResetsAt(
        rateLimitEvent({ status: 'rejected', resetsAt: '1800000000' }),
      ),
    ).toBeUndefined();
    expect(
      readClaudeQuotaResetsAt(
        rateLimitEvent({ status: 'rejected', resetsAt: -1 }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined for malformed payloads and other events', () => {
    expect(readClaudeQuotaResetsAt(null)).toBeUndefined();
    expect(readClaudeQuotaResetsAt('rate_limit_event')).toBeUndefined();
    expect(readClaudeQuotaResetsAt(rateLimitEvent(null))).toBeUndefined();
    expect(
      readClaudeQuotaResetsAt({
        type: 'result',
        rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 },
      }),
    ).toBeUndefined();
  });
});
