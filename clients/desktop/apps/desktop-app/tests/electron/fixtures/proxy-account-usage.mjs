import { defaultFakeProxyState } from './fake-account-proxy.mjs';

export const PROXY_USAGE_RESET = '2030-10-20T20:00:00.000Z';
export const PROXY_USAGE_CLAUDE = 'a1f3c2d4a1f3c2d4';
export const PROXY_USAGE_CODEX = '4c55d0194c55d019';

/** Real v8 casing and provider payload shapes, without any provider traffic. */
export function proxyAccountUsageState() {
  const state = defaultFakeProxyState();
  state.files = state.files.filter((file) => !file.unavailable);
  for (const file of state.files) {
    if (file.provider === 'claude') {
      file.quota = {
        observed_at: '2026-10-20T12:00:00.000Z',
        signals: {
          'Anthropic-Ratelimit-Unified-5h-Utilization': '0.35',
          'Anthropic-Ratelimit-Unified-5h-Reset': String(
            Date.parse(PROXY_USAGE_RESET) / 1000,
          ),
          'Anthropic-Ratelimit-Unified-7d-Utilization': '0.70',
        },
      };
    } else {
      file.id_token = {
        plan_type: 'pro',
        chatgpt_account_id: 'fixture-proxy-codex-account',
      };
      file.quota = {
        observed_at: '2026-10-20T12:00:00.000Z',
        signals: {
          'X-Codex-Primary-Used-Percent': '42',
          'X-Codex-Primary-Window-Minutes': '300',
          'X-Codex-Primary-Reset-At': String(
            Date.parse(PROXY_USAGE_RESET) / 1000,
          ),
        },
      };
    }
  }
  state.profileByAuthIndex = {
    [PROXY_USAGE_CLAUDE]: {
      body: {
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      },
    },
  };
  state.usageByAuthIndex = {
    [PROXY_USAGE_CLAUDE]: {
      body: {
        five_hour: { utilization: 35, resets_at: PROXY_USAGE_RESET },
        seven_day: { utilization: 70, resets_at: PROXY_USAGE_RESET },
        seven_day_sonnet: { utilization: 20, resets_at: PROXY_USAGE_RESET },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 25,
          utilization: 25,
        },
      },
    },
    [PROXY_USAGE_CODEX]: {
      body: {
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18000,
            reset_at: Date.parse(PROXY_USAGE_RESET) / 1000,
          },
          secondary_window: {
            used_percent: 60,
            limit_window_seconds: 604800,
            reset_at: Date.parse(PROXY_USAGE_RESET) / 1000,
          },
        },
        code_review_rate_limit: {
          primary_window: {
            used_percent: 15,
            limit_window_seconds: 604800,
            reset_at: Date.parse(PROXY_USAGE_RESET) / 1000,
          },
        },
        credits: { has_credits: true, unlimited: false, balance: '123' },
      },
    },
  };
  return state;
}
