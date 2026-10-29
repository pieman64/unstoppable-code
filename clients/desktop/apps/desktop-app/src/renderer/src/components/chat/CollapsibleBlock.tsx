import { memo, useContext, type JSX } from 'react';
import {
  CollapsibleBlock as SharedCollapsibleBlock,
  type CollapsibleBlockProps as SharedCollapsibleBlockProps,
} from '@canopy/ui-shared/components';
import { TranscriptSearchRevealContext } from './transcript-search-reveal';

export interface CollapsibleBlockProps extends SharedCollapsibleBlockProps {
  forceExpanded?: SharedCollapsibleBlockProps['forceExpanded'];
}

export const CollapsibleBlock = memo(function CollapsibleBlock({
  ...props
}: CollapsibleBlockProps): JSX.Element {
  const reveal = useContext(TranscriptSearchRevealContext);
  return (
    <SharedCollapsibleBlock
      {...props}
      forceExpanded={props.forceExpanded || reveal}
    />
  );
});
