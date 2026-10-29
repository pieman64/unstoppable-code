import { useCallback, type JSX } from 'react';
import { Tooltip } from '@canopy/ui-shared';
import { useClipboardCopy } from '@/hooks/useClipboardCopy';
import {
  CheckIcon as AppCatalogCheckIcon,
  Copy as AppCatalogCopy,
} from '@canopy/ui-shared/icons/AppIcons';

interface MessageCopyButtonProps {
  getText: () => string;
  className: string;
}

function CopiedIcon(): JSX.Element {
  return <AppCatalogCheckIcon width="14" height="14" />;
}

function CopyIcon(): JSX.Element {
  return <AppCatalogCopy width="14" height="14" />;
}

export function MessageCopyButton({
  getText,
  className,
}: MessageCopyButtonProps): JSX.Element {
  const { copied, copy } = useClipboardCopy();

  const handleCopy = useCallback((): void => {
    void copy(getText());
  }, [copy, getText]);

  const label = copied ? 'Copied' : 'Copy to clipboard';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={handleCopy}
        className={className}
        aria-label={label}
      >
        {copied ? <CopiedIcon /> : <CopyIcon />}
      </button>
    </Tooltip>
  );
}
