import type { JSX } from 'react';

interface ExternalTextLinkProps {
  href: string;
  label: string;
}

/** A text link that opens outside the app, as in detail-page link rows. */
export function ExternalTextLink({
  href,
  label,
}: ExternalTextLinkProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring rounded text-xs font-medium fg-accent hover:underline"
    >
      {label}
    </a>
  );
}
