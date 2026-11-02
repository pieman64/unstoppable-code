import {
  useCallback,
  useId,
  useRef,
  useState,
  type JSX,
  type Ref,
} from 'react';
import { Button } from '@canopy/ui-shared/components/Button';
import { ComponentSection } from '@canopy/ui-shared/components/ComponentSection';
import { ShareAudienceLabel } from '@canopy/ui-shared/components/ShareAudienceLabel';
import { MARKETPLACE_UNSHARE_LABEL } from '@canopy/ui-shared/lib/marketplace-unshare';
import type { MarketplaceUnshareKind } from '@canopy/ui-shared/lib/marketplace-unshare';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  SHARED_BY_YOU_REMOVE_LINK_ERROR,
  SHARED_BY_YOU_TITLE,
  sharedByYouRemoveLinkAriaLabel,
  sharedByYouSinceLabel,
  sharedByYouUnshareAriaLabel,
} from '@canopy/ui-shared/lib/shared-by-you';
import { RemovePublicLinkConfirmDialog } from '../sharing/RemovePublicLinkConfirmDialog';
import type { SharedByYouAudience } from '../sharing/sharedByYouAudiences';
import { useMarketplaceUnshare } from './MarketplaceUnshareAction';

type AccountAudience = Extract<SharedByYouAudience, { id: 'account' }>;
type PublicAudience = Extract<SharedByYouAudience, { id: 'public' }>;

export interface SharedByYouSectionProps {
  readonly kind: MarketplaceUnshareKind;
  /** The shared item's user-authored name, masked for session replay. */
  readonly name: string;
  readonly audiences: readonly SharedByYouAudience[];
  /** Runs once after an audience was removed. */
  readonly onUnshared: (audience: SharedByYouAudience) => void;
  readonly dataTestId?: string;
}

const ROW_CLASS = 'flex items-center gap-4 px-4 py-2.5 text-s';
const ACCOUNT_PERSONAL_NAME = 'Personal';

/**
 * "Shared by you" (CAN-4842): one row per audience the owner shared an item
 * with, each with its own Unshare. The account row deletes the share (its
 * public link goes too); the public-link row removes only the link. A host
 * that cannot run an action supplies it disabled with a reason.
 */
export function SharedByYouSection({
  kind,
  name,
  audiences,
  onUnshared,
  dataTestId = 'shared-by-you',
}: SharedByYouSectionProps): JSX.Element | null {
  if (audiences.length === 0) return null;
  return (
    <div data-testid={dataTestId}>
      <ComponentSection title={SHARED_BY_YOU_TITLE}>
        <ul className="divide-y">
          {audiences.map((audience) =>
            audience.id === 'account' ? (
              <SharedByYouAccountRow
                key={audience.id}
                kind={kind}
                name={name}
                audience={audience}
                onUnshared={onUnshared}
              />
            ) : (
              <SharedByYouPublicLinkRow
                // Keyed on the link's identity: a re-published link is a new
                // row, so a removed link's disabled state never carries over.
                key={`${audience.id}:${audience.linkId ?? audience.sinceIso ?? ''}`}
                name={name}
                audience={audience}
                onUnshared={onUnshared}
              />
            ),
          )}
        </ul>
      </ComponentSection>
    </div>
  );
}

function RowSince({
  id,
  sinceIso,
}: {
  id: SharedByYouAudience['id'];
  sinceIso?: string;
}): JSX.Element | null {
  if (sinceIso === undefined) return null;
  return (
    <span
      data-testid={`shared-by-you-since-${id}`}
      className="shrink-0 text-xs fg-tertiary"
    >
      {sharedByYouSinceLabel(sinceIso)}
    </span>
  );
}

function RowUnshare({
  id,
  ariaLabel,
  action,
  disabled = false,
  onClick,
  buttonRef,
}: {
  id: SharedByYouAudience['id'];
  ariaLabel: string;
  action: SharedByYouAudience['action'];
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const reasonId = useId();
  return (
    <div className="ml-auto flex shrink-0 items-center gap-3">
      {!action.available && (
        <span
          id={reasonId}
          data-testid={`shared-by-you-reason-${id}`}
          className="text-xs fg-tertiary"
        >
          {action.reason}
        </span>
      )}
      <Button
        ref={buttonRef}
        variant="ghost-destructive"
        size="compact"
        data-testid={`shared-by-you-unshare-${id}`}
        aria-label={ariaLabel}
        aria-describedby={action.available ? undefined : reasonId}
        disabled={!action.available || disabled}
        onClick={action.available ? onClick : undefined}
      >
        {MARKETPLACE_UNSHARE_LABEL}
      </Button>
    </div>
  );
}

const NOTHING_TO_RUN = (): Promise<void> => Promise.resolve();

function SharedByYouAccountRow({
  kind,
  name,
  audience,
  onUnshared,
}: {
  kind: MarketplaceUnshareKind;
  name: string;
  audience: AccountAudience;
  onUnshared: (audience: SharedByYouAudience) => void;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { action } = audience;
  const displayName = audience.personal ? ACCOUNT_PERSONAL_NAME : audience.name;
  const unshare = useMarketplaceUnshare({
    kind,
    name,
    ownerName: displayName,
    onUnshare: action.available ? action.run : NOTHING_TO_RUN,
    onUnshared: () => onUnshared(audience),
    dataTestId: 'shared-by-you-unshare-account',
    restoreFocusRef: triggerRef,
  });
  return (
    <li data-testid="shared-by-you-row-account" className={ROW_CLASS}>
      <span className={`min-w-0 truncate fg-primary ${REPLAY_MASK_CLASS}`}>
        {displayName}
      </span>
      <ShareAudienceLabel audience={audience.audience} />
      <RowSince id="account" sinceIso={audience.sinceIso} />
      <RowUnshare
        id="account"
        ariaLabel={sharedByYouUnshareAriaLabel(name, displayName)}
        action={action}
        disabled={unshare.disabled}
        onClick={unshare.open}
        buttonRef={triggerRef}
      />
      {unshare.dialog}
    </li>
  );
}

function SharedByYouPublicLinkRow({
  name,
  audience,
  onUnshared,
}: {
  name: string;
  audience: PublicAudience;
  onUnshared: (audience: SharedByYouAudience) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  // A ref, not state: a second confirm in the same frame must not run twice.
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { action } = audience;

  const close = useCallback((): void => {
    if (inFlight.current) return;
    setOpen(false);
    setError(null);
  }, []);

  const confirm = useCallback((): void => {
    if (!action.available || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    action.run().then(
      () => {
        inFlight.current = false;
        setBusy(false);
        setRemoved(true);
        setOpen(false);
        try {
          onUnshared(audience);
        } catch {
          // The link is gone; a refresh failure must not read as a failed
          // removal or invite another one.
        }
      },
      () => {
        inFlight.current = false;
        setBusy(false);
        setError(SHARED_BY_YOU_REMOVE_LINK_ERROR);
      },
    );
  }, [action, audience, onUnshared]);

  return (
    <li data-testid="shared-by-you-row-public" className={ROW_CLASS}>
      <span className="min-w-0 truncate fg-primary">{audience.name}</span>
      <RowSince id="public" sinceIso={audience.sinceIso} />
      <RowUnshare
        id="public"
        ariaLabel={sharedByYouRemoveLinkAriaLabel(name)}
        action={action}
        disabled={busy || removed}
        onClick={(): void => setOpen(true)}
        buttonRef={triggerRef}
      />
      {open && (
        <RemovePublicLinkConfirmDialog
          testIdPrefix="shared-by-you"
          trapFocus
          restoreFocusRef={triggerRef}
          {...(audience.remainingAudience
            ? { remainingAudience: audience.remainingAudience }
            : {})}
          busy={busy}
          onCancel={close}
          onConfirm={confirm}
          errorMessage={error}
        />
      )}
    </li>
  );
}
