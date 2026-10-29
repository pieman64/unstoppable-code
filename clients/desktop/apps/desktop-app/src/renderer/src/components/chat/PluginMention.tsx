import { memo, type JSX, type ReactNode } from 'react';
import { InlineMention } from '@canopy/ui-shared';
import { PluginsIcon } from '@canopy/ui-shared/icons';
import type { PluginMentionTarget } from '@/lib/pluginMentionIndex';

interface PluginMentionProps {
  target: PluginMentionTarget;
  children: ReactNode;
}

/**
 * Inline chip for a whole-plugin `@` mention inside a sent user message —
 * the transcript counterpart of the composer's plugin pill. Display-only:
 * unlike `FilePathMention` there is nothing to open, so it is a plain span.
 */
export const PluginMention = memo(function PluginMention({
  target,
  children,
}: PluginMentionProps): JSX.Element {
  return (
    <InlineMention
      icon={PluginsIcon}
      title={`Plugin: ${target.label}`}
      data-testid="plugin-mention"
      data-plugin-name={target.pluginName}
    >
      {children}
    </InlineMention>
  );
});
