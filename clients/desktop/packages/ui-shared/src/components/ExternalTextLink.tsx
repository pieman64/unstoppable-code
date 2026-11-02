import type { ButtonHTMLAttributes, JSX } from 'react';
import { Button, buttonClassName } from './Button';

interface ExternalTextLinkProps {
  href: string;
  label: string;
}

/**
 * A text link that opens outside the app, as in detail-page link rows. It
 * wears `Button`'s `link` look, so a real link and a link action match.
 */
export function ExternalTextLink({
  href,
  label,
}: ExternalTextLinkProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClassName({ variant: 'link', className: 'text-xs' })}
    >
      {label}
    </a>
  );
}

export type TextLinkButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'className'
>;

/**
 * The same text link for a host action inside a sentence: opening a page
 * through the host's external browser, or switching a form's mode. It is
 * `Button variant="link"` and takes the size of the copy around it.
 */
export function TextLinkButton(props: TextLinkButtonProps): JSX.Element {
  return <Button {...props} variant="link" data-settings-control="link" />;
}
