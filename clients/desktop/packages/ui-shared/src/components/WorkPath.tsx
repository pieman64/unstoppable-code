import { Fragment } from 'react';
import type { JSX } from 'react';
import { ForwardIcon } from '../icons/AppIcons';
import { Button } from './Button';

export interface WorkPathPart {
  /** Stable React key. */
  readonly key: string;
  readonly label: string;
  /** Opens what the part names; without it the part is plain text. */
  readonly onOpen?: () => void;
}

export interface WorkPathProps {
  /** Largest first: project, task, then operation or chat. */
  readonly parts: readonly WorkPathPart[];
  readonly className?: string;
  readonly testId?: string;
}

/** Shows where something belongs, from its largest context to its most specific. */
export function WorkPath({
  parts,
  className,
  testId,
}: WorkPathProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      className={`inline-flex min-w-0 max-w-full items-center gap-1 truncate${
        className ? ` ${className}` : ''
      }`}
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && (
            <ForwardIcon
              size={12}
              aria-hidden="true"
              className="shrink-0 fg-quaternary"
            />
          )}
          {part.onOpen === undefined ? (
            <span className="min-w-0 truncate">{part.label}</span>
          ) : (
            <Button
              type="button"
              variant="link"
              onClick={(event): void => {
                event.stopPropagation();
                part.onOpen?.();
              }}
              className="min-w-0"
            >
              {/* A block label clips to the shrunk button; an inline one
                  spills over the next part. */}
              <span className="block truncate">{part.label}</span>
            </Button>
          )}
        </Fragment>
      ))}
    </span>
  );
}
