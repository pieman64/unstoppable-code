'use client';

import type { JSX, ReactNode } from 'react';
import { CONTACT_ORG_ADMIN_COPY } from './creditsRecoveryCopy';
import { Notice, type NoticeProps } from './Notice';

export interface CreditsRecoveryNoticeProps extends Omit<
  NoticeProps,
  'detail'
> {
  /** Supporting lines under the message, one per line, in this order. */
  readonly detailLines?: readonly ReactNode[];
  /** Close the detail with the line telling an org member to ask an admin. */
  readonly contactAdmin?: boolean;
  readonly contactAdminTestId?: string;
  readonly 'data-testid'?: string;
}

/**
 * CAN-4764 — the in-chat out-of-credits recovery notice, shared by the desktop
 * no-billing-source banner and the web cloud credit recovery notice. Purely
 * presentational: the host decides whether it shows, which copy applies, and
 * what the actions do.
 */
export function CreditsRecoveryNotice({
  detailLines = [],
  contactAdmin = false,
  contactAdminTestId,
  children,
  ...props
}: CreditsRecoveryNoticeProps): JSX.Element {
  const hasDetail = detailLines.length > 0 || contactAdmin;
  return (
    <Notice
      {...props}
      {...(hasDetail
        ? {
            detail: (
              <>
                {detailLines.map((line, index) => (
                  // A host may drop a line between renders, shifting the
                  // others' indexes. Lines are stateless display content, so
                  // an index key only re-renders them.
                  <span key={index} className="block">
                    {line}
                  </span>
                ))}
                {contactAdmin ? (
                  <span className="block" data-testid={contactAdminTestId}>
                    {CONTACT_ORG_ADMIN_COPY}
                  </span>
                ) : null}
              </>
            ),
          }
        : {})}
    >
      {children}
    </Notice>
  );
}
