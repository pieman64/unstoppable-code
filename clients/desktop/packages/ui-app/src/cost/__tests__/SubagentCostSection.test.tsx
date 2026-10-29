/** @jest-environment jsdom */
import { type CostChatView } from '@canopy/protocol/cost-view';
import { SubagentCostSection } from '../SubagentCostSection';
import {
  ENTRY_SCOPE,
  attributedItem,
  chatRow,
  createCostRenderer,
  createFakeCostClient,
  flush,
  ok,
  type CostRenderer,
} from './cost-test-utils';

describe('SubagentCostSection', () => {
  let renderer: CostRenderer | null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('loads the subagent row and opens the root chat Session breakdown', async () => {
    const client = createFakeCostClient({
      chat: ok<CostChatView>({
        kind: 'subagent',
        chat: chatRow(),
        item: attributedItem({
          id: 'delegate-1',
          kind: 'delegation',
          billingBasis: 'ai_credits',
          usd: 0.9,
          costStatus: 'estimated',
          inclusion: 'additional',
          runCount: 2,
        }),
      }),
    });
    const navigator = { openSessionBreakdown: jest.fn() };
    renderer = createCostRenderer();
    renderer.render(
      <SubagentCostSection
        client={client}
        navigator={navigator}
        scope={ENTRY_SCOPE}
        chatId="root-chat"
        subagentId="delegate-1"
      />,
    );
    expect(renderer.container.textContent).toContain('Loading cost…');

    await flush();

    expect(renderer.container.textContent).toContain('$0.90');
    expect(renderer.container.textContent).toContain(
      'AI Credits, estimated at API prices',
    );
    expect(client.getChat).toHaveBeenCalledWith({
      scope: ENTRY_SCOPE,
      chatId: 'root-chat',
      subagentId: 'delegate-1',
    });
    renderer.container
      .querySelector<HTMLButtonElement>(
        '[data-testid="subagent-cost-details-open-breakdown"]',
      )
      ?.click();
    expect(navigator.openSessionBreakdown).toHaveBeenCalledWith(
      ENTRY_SCOPE,
      'root-chat',
    );
  });

  it('shows the total-only token count returned for a Codex subagent', async () => {
    const client = createFakeCostClient({
      chat: ok<CostChatView>({
        kind: 'subagent',
        chat: chatRow(),
        item: attributedItem({
          id: 'codex-agent',
          kind: 'codex_agent',
          model: 'GPT 6 Sol',
          totalTokens: 11_293_358,
          tokens: {
            input: 0,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningOutputTokens: 0,
          },
        }),
      }),
    });
    renderer = createCostRenderer();
    renderer.render(
      <SubagentCostSection
        client={client}
        navigator={{}}
        scope={ENTRY_SCOPE}
        chatId="root-chat"
        subagentId="codex-agent"
      />,
    );
    await flush();

    expect(renderer.container.textContent).toContain('11.3M');
    expect(renderer.container.textContent).not.toContain('Input0');
    expect(renderer.container.textContent).not.toContain('Output0');
  });

  it('shows the quiet not-found message and a generic failure without retry', async () => {
    const notFound = createFakeCostClient({
      chat: {
        status: 'error',
        reason: 'NOT_FOUND',
        message: 'No cost item.',
      },
    });
    renderer = createCostRenderer();
    renderer.render(
      <SubagentCostSection
        client={notFound}
        navigator={{}}
        scope={ENTRY_SCOPE}
        chatId="root-chat"
        subagentId="missing"
      />,
    );
    await flush();
    expect(renderer.container.textContent).toContain('No cost recorded yet.');
    expect(renderer.container.querySelector('button')).toBeNull();
    renderer.unmount();
    renderer = null;

    const failed = createFakeCostClient({
      chat: {
        status: 'error',
        reason: 'UNKNOWN',
        message: 'Read failed.',
      },
    });
    renderer = createCostRenderer();
    renderer.render(
      <SubagentCostSection
        client={failed}
        navigator={{}}
        scope={ENTRY_SCOPE}
        chatId="root-chat"
        subagentId="failed"
      />,
    );
    await flush();
    expect(renderer.container.textContent).toContain("Couldn't load cost.");
    expect(renderer.container.querySelector('button')).toBeNull();
  });

  it('renders nothing and does not read when cost insights are disabled', async () => {
    const client = createFakeCostClient();
    renderer = createCostRenderer({ costInsights: false });
    renderer.render(
      <SubagentCostSection
        client={client}
        navigator={{}}
        scope={ENTRY_SCOPE}
        chatId="root-chat"
        subagentId="subagent-1"
      />,
    );

    await flush();

    expect(renderer.container.textContent).toBe('');
    expect(client.getChat).not.toHaveBeenCalled();
  });
});
