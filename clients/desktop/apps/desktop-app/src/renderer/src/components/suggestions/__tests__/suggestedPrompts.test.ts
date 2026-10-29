import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import { MCP_BRAND_LOGOS } from '@/lib/mcpBrandLogos';
import {
  GENERIC_FALLBACK_PROMPTS,
  MCP_PROMPT_INDEX,
  synthesizedPromptForServer,
} from '../mcpPromptIndex';
import {
  MAX_SUGGESTED_PROMPTS,
  eligibleCuratedServers,
  pickSuggestedPrompts,
  suggestionPoolSignature,
  type EligibleCuratedServer,
} from '../suggestedPrompts';

function server(
  overrides: Partial<DetectedMcpServerInfo>,
): DetectedMcpServerInfo {
  return {
    key: 'standalone:server:default',
    source: 'standalone',
    serverName: 'Server',
    displayName: 'Server',
    type: 'http',
    enabled: true,
    authStatus: 'connected',
    authStatusLabel: 'Connected',
    canConnect: false,
    ...overrides,
  };
}

function eligible(key: string, displayName = key): EligibleCuratedServer {
  return { key, displayName };
}

/** Deterministic LCG so picks are reproducible in tests. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('eligibleCuratedServers', () => {
  it('includes enabled curated servers with usable auth statuses', () => {
    const servers = [
      server({
        curatedKey: 'github',
        displayName: 'GitHub',
        authStatus: 'connected',
      }),
      server({
        key: 'k2',
        curatedKey: 'linear',
        displayName: 'Linear',
        authStatus: 'not_configured',
      }),
      server({
        key: 'k3',
        curatedKey: 'sentry',
        displayName: 'Sentry',
        authStatus: 'unsupported',
      }),
    ];
    expect(eligibleCuratedServers(servers)).toEqual([
      { key: 'github', displayName: 'GitHub' },
      { key: 'linear', displayName: 'Linear' },
      { key: 'sentry', displayName: 'Sentry' },
    ]);
  });

  it('excludes unauthorized, errored, disabled, and uncurated servers', () => {
    const servers = [
      server({ curatedKey: 'github', authStatus: 'not_connected' }),
      server({ key: 'k2', curatedKey: 'linear', authStatus: 'expired' }),
      server({ key: 'k3', curatedKey: 'sentry', authStatus: 'error' }),
      server({ key: 'k4', curatedKey: 'notion', enabled: false }),
      server({ key: 'k5' }),
    ];
    expect(eligibleCuratedServers(servers)).toEqual([]);
  });

  it('de-duplicates repeated curated keys, keeping the first-seen name', () => {
    const servers = [
      server({ curatedKey: 'github', displayName: 'GitHub' }),
      server({ key: 'k2', curatedKey: 'github', displayName: 'GitHub Copy' }),
    ];
    expect(eligibleCuratedServers(servers)).toEqual([
      { key: 'github', displayName: 'GitHub' },
    ]);
  });
});

describe('suggestionPoolSignature', () => {
  it('is order-independent and stable', () => {
    expect(suggestionPoolSignature(['linear', 'github'])).toBe(
      suggestionPoolSignature(['github', 'linear']),
    );
    expect(suggestionPoolSignature([])).toBe('');
  });
});

describe('synthesizedPromptForServer', () => {
  it('builds a name-based prompt keyed to the curated entry', () => {
    expect(synthesizedPromptForServer('acme-crm', 'Acme CRM')).toEqual({
      id: 'acme-crm-synthesized-1',
      curatedKey: 'acme-crm',
      text: 'Show me what I can do with Acme CRM',
    });
  });

  it('falls back to the curated key when the display name is blank', () => {
    expect(synthesizedPromptForServer('acme-crm', '   ').text).toBe(
      'Show me what I can do with acme-crm',
    );
  });
});

describe('pickSuggestedPrompts', () => {
  it('defines the exact home and chat generic fallback pools', () => {
    expect(GENERIC_FALLBACK_PROMPTS.home).toEqual([
      {
        id: 'generic-home-1',
        curatedKey: null,
        text: 'Research a topic and write up what matters',
      },
      {
        id: 'generic-home-2',
        curatedKey: null,
        text: 'Plan a project and break it into steps',
      },
      {
        id: 'generic-home-3',
        curatedKey: null,
        text: 'Turn rough notes into a polished document',
      },
      {
        id: 'generic-home-4',
        curatedKey: null,
        text: 'Draft an email, post, or announcement',
      },
      {
        id: 'generic-home-5',
        curatedKey: null,
        text: 'Make sense of a spreadsheet or data file',
      },
      {
        id: 'generic-home-6',
        curatedKey: null,
        text: 'Build a small tool from scratch',
      },
    ]);
    expect(GENERIC_FALLBACK_PROMPTS.chat).toEqual([
      {
        id: 'generic-1',
        curatedKey: null,
        text: 'Explain the architecture of this codebase',
      },
      {
        id: 'generic-2',
        curatedKey: null,
        text: 'Find and fix a small bug worth cleaning up',
      },
      {
        id: 'generic-3',
        curatedKey: null,
        text: 'Review my latest changes and suggest fixes',
      },
      {
        id: 'generic-4',
        curatedKey: null,
        text: 'Add tests to the least-tested code',
      },
      {
        id: 'generic-5',
        curatedKey: null,
        text: 'Write docs for an undocumented area',
      },
    ]);
  });

  it('uses the surface-specific generic fallback pool', () => {
    const home = pickSuggestedPrompts([], seededRandom(1), 'home');
    const chat = pickSuggestedPrompts([], seededRandom(1), 'chat');

    expect(
      home.every(
        (prompt) =>
          prompt.id.startsWith('generic-home-') &&
          [
            'Research a topic and write up what matters',
            'Plan a project and break it into steps',
            'Turn rough notes into a polished document',
            'Draft an email, post, or announcement',
            'Make sense of a spreadsheet or data file',
            'Build a small tool from scratch',
          ].includes(prompt.text),
      ),
    ).toBe(true);
    expect(chat.every((prompt) => /^generic-[1-5]$/.test(prompt.id))).toBe(
      true,
    );
  });

  it('is deterministic for a given random source', () => {
    const first = pickSuggestedPrompts(
      [eligible('github'), eligible('linear')],
      seededRandom(7),
      'chat',
    );
    const second = pickSuggestedPrompts(
      [eligible('github'), eligible('linear')],
      seededRandom(7),
      'chat',
    );
    expect(first).toEqual(second);
  });

  it('returns at most the maximum and always a full set via fallbacks', () => {
    const none = pickSuggestedPrompts([], seededRandom(1), 'chat');
    expect(none).toHaveLength(MAX_SUGGESTED_PROMPTS);
    expect(none.every((prompt) => prompt.curatedKey === null)).toBe(true);

    const many = pickSuggestedPrompts(
      Object.keys(MCP_PROMPT_INDEX).map((key) => eligible(key)),
      seededRandom(1),
      'chat',
    );
    expect(many).toHaveLength(MAX_SUGGESTED_PROMPTS);
  });

  it('interleaves across distinct eligible MCPs before repeating one', () => {
    const picked = pickSuggestedPrompts(
      [eligible('github'), eligible('linear'), eligible('sentry')],
      seededRandom(3),
      'chat',
    );
    const keys = picked.map((prompt) => prompt.curatedKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('tops up from generic fallbacks when eligible prompts run out', () => {
    // One eligible MCP contributes its full pool; the remainder is generic.
    const singleKeyPool = MCP_PROMPT_INDEX['github'] ?? [];
    const picked = pickSuggestedPrompts(
      [eligible('github')],
      seededRandom(11),
      'chat',
    );
    expect(picked).toHaveLength(MAX_SUGGESTED_PROMPTS);
    const githubCount = picked.filter(
      (prompt) => prompt.curatedKey === 'github',
    ).length;
    expect(githubCount).toBe(
      Math.min(singleKeyPool.length, MAX_SUGGESTED_PROMPTS),
    );
    expect(
      picked
        .filter((prompt) => prompt.curatedKey === null)
        .every((prompt) =>
          GENERIC_FALLBACK_PROMPTS.chat.some((g) => g.id === prompt.id),
        ),
    ).toBe(true);
  });

  it('synthesizes a name-based prompt for eligible keys with no index entry', () => {
    const picked = pickSuggestedPrompts(
      [eligible('unknown-mcp', 'Unknown MCP')],
      seededRandom(5),
      'chat',
    );
    expect(picked).toHaveLength(MAX_SUGGESTED_PROMPTS);
    const synthesized = picked.filter(
      (prompt) => prompt.curatedKey === 'unknown-mcp',
    );
    expect(synthesized).toEqual([
      {
        id: 'unknown-mcp-synthesized-1',
        curatedKey: 'unknown-mcp',
        text: 'Show me what I can do with Unknown MCP',
      },
    ]);
    expect(
      picked
        .filter((prompt) => prompt.curatedKey === null)
        .every((prompt) =>
          GENERIC_FALLBACK_PROMPTS.chat.some((g) => g.id === prompt.id),
        ),
    ).toBe(true);
  });

  it('mixes indexed and synthesized prompts across eligible MCPs', () => {
    const picked = pickSuggestedPrompts(
      [
        eligible('github'),
        eligible('unknown-a', 'Unknown A'),
        eligible('unknown-b', 'Unknown B'),
      ],
      seededRandom(9),
      'chat',
    );
    const keys = picked.map((prompt) => prompt.curatedKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('treats Object.prototype member names as synthesized, not inherited entries', () => {
    for (const key of ['constructor', 'hasOwnProperty']) {
      const picked = pickSuggestedPrompts(
        [eligible(key, 'Proto Server')],
        seededRandom(5),
        'chat',
      );
      const curated = picked.filter((prompt) => prompt.curatedKey === key);
      expect(curated).toEqual([
        {
          id: `${key}-synthesized-1`,
          curatedKey: key,
          text: 'Show me what I can do with Proto Server',
        },
      ]);
    }
  });
});

describe('MCP_BRAND_LOGOS', () => {
  it('keeps every bundled mark a decodable inline SVG data URI', () => {
    const entries = Object.entries(MCP_BRAND_LOGOS);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [key, uri] of entries) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
      const decoded = Buffer.from(
        uri.slice('data:image/svg+xml;base64,'.length),
        'base64',
      ).toString('utf8');
      expect(decoded).toContain('<svg');
      expect(decoded).toContain('viewBox=');
      expect(decoded.toLowerCase()).not.toContain('<script');
    }
  });
});

describe('MCP_PROMPT_INDEX', () => {
  it('keeps every entry well-formed: 3 one-line prompts keyed to the entry', () => {
    for (const [key, prompts] of Object.entries(MCP_PROMPT_INDEX)) {
      expect(prompts).toHaveLength(3);
      prompts.forEach((prompt, index) => {
        expect(prompt.curatedKey).toBe(key);
        expect(prompt.id).toBe(`${key}-${index + 1}`);
        expect(prompt.text.trim().length).toBeGreaterThan(0);
        expect(prompt.text).not.toMatch(/\n/);
      });
    }
  });
});

describe('project starter prompts (CAN-2964 §8.1)', () => {
  it('tops up from the project set instead of the generic pool', () => {
    const picked = pickSuggestedPrompts([], seededRandom(7), 'cowork', [
      { id: 'ws-1', text: 'Draft this week’s update' },
      { id: 'ws-2', text: 'Turn the brief into a plan' },
      { id: 'ws-3', text: 'Review the launch copy' },
    ]);
    expect(picked).toHaveLength(MAX_SUGGESTED_PROMPTS);
    expect(picked.map((prompt) => prompt.id).sort()).toEqual([
      'ws-1',
      'ws-2',
      'ws-3',
    ]);
    // Project-authored prompts have no curated server behind them.
    expect(picked.every((prompt) => prompt.curatedKey === null)).toBe(true);
  });

  it('treats absent as "never set" and falls back to the surface pool', () => {
    const coworkIds = new Set(
      GENERIC_FALLBACK_PROMPTS.cowork.map((prompt) => prompt.id),
    );
    for (const starters of [undefined, null]) {
      const picked = pickSuggestedPrompts(
        [],
        seededRandom(3),
        'cowork',
        starters,
      );
      expect(picked).toHaveLength(MAX_SUGGESTED_PROMPTS);
      expect(picked.every((prompt) => coworkIds.has(prompt.id))).toBe(true);
    }
  });

  it('treats an explicit [] as "show no starters", not as a fallback', () => {
    expect(pickSuggestedPrompts([], seededRandom(3), 'cowork', [])).toEqual([]);
  });

  it('falls back from an absent project setting to the seeding Blueprint', () => {
    const blueprintStarters = [
      { id: 'blueprint-1', text: 'Start from the seeded brief' },
    ];
    expect(
      pickSuggestedPrompts(
        [],
        seededRandom(3),
        'cowork',
        undefined,
        blueprintStarters,
      ),
    ).toEqual([
      {
        id: 'blueprint-1',
        curatedKey: null,
        text: 'Start from the seeded brief',
        userAuthored: true,
      },
    ]);
    expect(
      pickSuggestedPrompts(
        [],
        seededRandom(3),
        'cowork',
        [],
        blueprintStarters,
      ),
    ).toEqual([]);
  });

  it('still interleaves eligible MCPs ahead of the project set', () => {
    // An un-indexed server contributes exactly one synthesized prompt, so the
    // remaining two slots come from the project set rather than the pool.
    const picked = pickSuggestedPrompts(
      [eligible('not-in-the-index', 'Some Connector')],
      seededRandom(11),
      'cowork',
      [
        { id: 'ws-1', text: 'Draft this week’s update' },
        { id: 'ws-2', text: 'Turn the brief into a plan' },
      ],
    );
    expect(picked).toHaveLength(MAX_SUGGESTED_PROMPTS);
    expect(picked[0].curatedKey).toBe('not-in-the-index');
    expect(
      picked
        .slice(1)
        .map((prompt) => prompt.id)
        .sort(),
    ).toEqual(['ws-1', 'ws-2']);
  });

  it('keeps the cowork pool free of the codebase vocabulary (§8)', () => {
    const coworkText = GENERIC_FALLBACK_PROMPTS.cowork
      .map((prompt) => prompt.text)
      .join(' ')
      .toLowerCase();
    expect(coworkText).not.toContain('codebase');
    expect(coworkText).not.toContain('bug');
    GENERIC_FALLBACK_PROMPTS.cowork.forEach((prompt, index) => {
      // Positional ids, namespaced away from the workspace-scoped `ws-*` set.
      expect(prompt.id).toBe(`generic-cowork-${index + 1}`);
      expect(prompt.curatedKey).toBeNull();
    });
  });

  it('never lets a pool id collide across surfaces or with `ws-*`', () => {
    const ids = Object.values(GENERIC_FALLBACK_PROMPTS).flatMap((prompts) =>
      prompts.map((prompt) => prompt.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => /^ws-\d+$/.test(id))).toBe(false);
  });
});
