/**
 * Server-rendered tests for the shared {@link CollapsedTurnSummary}. Validates
 * that each tool count produces a chip with the right `data-tool-chip` key
 * and that absent (zero/undefined) counts are omitted.
 */
import { renderToString } from 'react-dom/server';
import type { LayoutTier } from '../../../lib/layout-tier';
import { LayoutTierProvider } from '../../LayoutTierProvider';
import {
  CollapsedTurnSummary,
  CollapsedTurnSummaryRow,
} from '../CollapsedTurnSummary';

describe('CollapsedTurnSummary', () => {
  it('omits chips for absent counts', () => {
    const html = renderToString(
      <CollapsedTurnSummary summary={{}} isExpanded={false} />,
    );
    expect(html).not.toContain('data-tool-chip');
  });

  it('renders one chip per non-zero count', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{ bash: 3, read: 2, edit: 1 }}
        isExpanded={false}
      />,
    );
    expect(html).toContain('data-tool-chip="bash"');
    expect(html).toContain('data-tool-chip="read"');
    expect(html).toContain('data-tool-chip="edit"');
    expect(html).toContain('3');
    expect(html).toContain('2');
    expect(html).toContain('1');
  });

  it('renders chips for each supported family', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{
          bash: 1,
          read: 1,
          edit: 1,
          write: 1,
          grep: 1,
          glob: 1,
          todo: 1,
          web: 1,
          agent: 1,
          askUser: 1,
          scriptOutput: 1,
          claude: 1,
          watcher: 1,
          canopy: 1,
          graph: 1,
          appAdvisor: 1,
          thinking: 1,
          messages: 1,
          computerUse: 1,
          other: 1,
        }}
        isExpanded={false}
      />,
    );
    for (const key of [
      'bash',
      'read',
      'edit',
      'write',
      'grep',
      'glob',
      'todo',
      'web',
      'agent',
      'askUser',
      'scriptOutput',
      'claude',
      'watcher',
      'canopy',
      'graph',
      'appAdvisor',
      'thinking',
      'messages',
      'computerUse',
      'other',
    ]) {
      expect(html).toContain(`data-tool-chip="${key}"`);
    }
  });

  it('renders thinking and message chips', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{ thinking: 2, messages: 3 }}
        isExpanded={false}
      />,
    );

    expect(html).toContain('data-tool-chip="thinking"');
    expect(html).toContain('data-tool-chip="messages"');
    expect(html).toContain('aria-label="Agent steps: 3 messages, 2 thinking"');
  });

  it('can hide the leading label without changing automation or aria contracts', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{ bash: 1 }}
        isExpanded={false}
        hideLeadingLabel
        dataTestId="summary"
      />,
    );

    expect(html).not.toContain('1 step');
    expect(html).toContain('data-turn-step-count="1"');
    expect(html).toContain('data-tool-chip="bash"');
    expect(html).toContain('data-testid="summary"');
    expect(html).toContain('aria-label="Agent steps: 1 bash"');
  });

  it('omits chips when counts are zero', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{ bash: 0, read: 5 }}
        isExpanded={false}
      />,
    );
    expect(html).not.toContain('data-tool-chip="bash"');
    expect(html).toContain('data-tool-chip="read"');
  });

  it('reflects expanded state via aria-expanded', () => {
    const collapsed = renderToString(
      <CollapsedTurnSummary summary={{ bash: 1 }} isExpanded={false} />,
    );
    expect(collapsed).toContain('aria-expanded="false"');

    const expanded = renderToString(
      <CollapsedTurnSummary summary={{ bash: 1 }} isExpanded={true} />,
    );
    expect(expanded).toContain('aria-expanded="true"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{ bash: 1 }}
        isExpanded={false}
        dataTestId="summary"
      />,
    );
    expect(html).toContain('data-testid="summary"');
  });

  it('uses the supplied app icon for app chips', () => {
    const html = renderToString(
      <CollapsedTurnSummary
        summary={{ canopy: 1 }}
        isExpanded={false}
        appIcon={<svg data-testid="brand-app-icon" />}
      />,
    );
    expect(html).toContain('data-tool-chip="canopy"');
    expect(html).toContain('data-testid="brand-app-icon"');
  });

  it('renders memory tool activity through the shared canopy aggregate', () => {
    const html = renderToString(
      <CollapsedTurnSummary summary={{ canopy: 2 }} isExpanded={false} />,
    );

    expect(html).toContain('data-tool-chip="canopy"');
    expect(html).toContain('2');
  });

  /**
   * Before this label the row was chips and nothing else: a turn that ran one
   * tool rendered as a ~30px strip reading "wrench 1", with the entire meaning
   * carried by an `aria-label` a sighted user never sees.
   */
  describe('step-count label', () => {
    it('sums the chip counts into a leading label', () => {
      const html = renderToString(
        <CollapsedTurnSummary
          summary={{ bash: 3, read: 1 }}
          isExpanded={false}
        />,
      );

      expect(html).toContain('4 steps');
      expect(html).toContain('data-turn-step-count="4"');
    });

    it('uses the singular for a one-step turn', () => {
      const html = renderToString(
        <CollapsedTurnSummary summary={{ bash: 1 }} isExpanded={false} />,
      );

      expect(html).toContain('1 step');
      expect(html).not.toContain('1 steps');
    });

    /**
     * A turn whose intermediate messages carry only reasoning produces no
     * chips, so `totalSteps` is 0 — but the turn IS expandable, because
     * `hasCollapsibleIntermediate` counts thinking/text parts. "0 steps" would
     * tell the reader there is nothing behind the chevron and discourage the
     * click, so the row falls back to a neutral label instead. The row must
     * still be labelled (that is why the label exists), just not falsely.
     */
    it('labels an empty summary neutrally rather than claiming zero steps', () => {
      const html = renderToString(
        <CollapsedTurnSummary summary={{}} isExpanded={false} />,
      );

      expect(html).toContain('Agent steps');
      expect(html).not.toContain('0 steps');
    });

    it('omits the dangling colon from aria-label when there are no chips', () => {
      const html = renderToString(
        <CollapsedTurnSummary summary={{}} isExpanded={false} />,
      );

      expect(html).toContain('aria-label="Agent steps"');
      expect(html).not.toContain('aria-label="Agent steps: "');
    });

    it('still counts steps normally when the turn ran tools', () => {
      const html = renderToString(
        <CollapsedTurnSummary summary={{ bash: 1 }} isExpanded={false} />,
      );

      expect(html).toContain('1 step');
    });

    /**
     * The chips, the `aria-label`, the `data-tool-chip` keys, and
     * `dataTestId` are all load-bearing for desktop UI automation. Adding the
     * label must not disturb any of them.
     */
    it('keeps the existing chip, aria, and testid contracts intact', () => {
      const html = renderToString(
        <CollapsedTurnSummary
          summary={{ bash: 2, read: 1 }}
          isExpanded={false}
          dataTestId="summary"
        />,
      );

      expect(html).toContain('aria-label="Agent steps: 2 bash, 1 read"');
      expect(html).toContain('data-tool-chip="bash"');
      expect(html).toContain('data-tool-chip="read"');
      expect(html).toContain('data-testid="summary"');
    });
  });

  describe('elapsed time', () => {
    it('renders a host-supplied duration next to the step count', () => {
      const html = renderToString(
        <CollapsedTurnSummary
          summary={{ bash: 4 }}
          isExpanded={false}
          elapsedMs={12_000}
        />,
      );

      expect(html).toContain('4 steps');
      expect(html).toContain('data-turn-elapsed="12s"');
    });

    it('formats a multi-minute turn', () => {
      const html = renderToString(
        <CollapsedTurnSummary
          summary={{ bash: 1 }}
          isExpanded={false}
          elapsedMs={90_000}
        />,
      );

      expect(html).toContain('data-turn-elapsed="1m 30s"');
    });

    /**
     * `formatDuration` rounds to whole seconds, so a sub-second turn would
     * otherwise claim it took "0s". (`renderToString` escapes the `<`.)
     */
    it('says "<1s" rather than "0s" for a sub-second turn', () => {
      const html = renderToString(
        <CollapsedTurnSummary
          summary={{ bash: 1 }}
          isExpanded={false}
          elapsedMs={400}
        />,
      );

      expect(html).toContain('data-turn-elapsed="&lt;1s"');
      expect(html).not.toContain('data-turn-elapsed="0s"');
    });

    it('renders nothing for absent, zero, or non-finite durations', () => {
      for (const elapsedMs of [undefined, 0, -5, Number.NaN]) {
        const html = renderToString(
          <CollapsedTurnSummary
            summary={{ bash: 1 }}
            isExpanded={false}
            elapsedMs={elapsedMs}
          />,
        );

        expect(html).not.toContain('data-turn-elapsed');
        expect(html).toContain('1 step');
      }
    });
  });

  /**
   * The tier is driven through {@link LayoutTierProvider}, whose seed is what
   * `useLayoutTier` returns from its *server* snapshot — which is exactly the
   * snapshot `renderToString` reads. That keeps these assertions in the same
   * server-rendered style as the rest of this file instead of standing up a
   * DOM root and a fake MediaQueryList for a styling check.
   */
  describe('phone-tier touch target', () => {
    function renderAt(tier: LayoutTier): string {
      return renderToString(
        <LayoutTierProvider tier={tier}>
          <CollapsedTurnSummary summary={{ bash: 1 }} isExpanded={false} />
        </LayoutTierProvider>,
      );
    }

    it('takes the 44px floor on the phone tier', () => {
      const classes = renderAt('phone')
        .match(/<button[^>]*class="([^"]*)"/)?.[1]
        .split(/\s+/);
      expect(classes).toContain('min-h-11');
    });

    /**
     * A tablet, a desktop, and the unseeded Electron renderer all keep the
     * dense `py-2` row they have room for.
     */
    it('keeps the compact height at tablet, desktop, and unseeded', () => {
      expect(renderAt('tablet')).not.toContain('min-h-11');
      expect(renderAt('desktop')).not.toContain('min-h-11');
      expect(
        renderToString(
          <CollapsedTurnSummary summary={{ bash: 1 }} isExpanded={false} />,
        ),
      ).not.toContain('min-h-11');
    });

    /** The desktop transcript keeps its dense row at every tier. */
    it('lets a host opt the shell out of the phone floor', () => {
      const html = renderToString(
        <LayoutTierProvider tier="phone">
          <CollapsedTurnSummaryRow
            isExpanded={false}
            ariaLabel="Agent steps: 1 bash"
            phoneTouchTarget={false}
          >
            <span data-tool-chip="bash">1</span>
          </CollapsedTurnSummaryRow>
        </LayoutTierProvider>,
      );
      expect(html).not.toContain('min-h-11');
      expect(html).toContain('data-tool-chip="bash"');
    });
  });
});
