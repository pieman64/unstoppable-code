import { useEffect, type JSX } from 'react';
import {
  useOnboardingTipsStore,
  useOptionalCanopyClient,
} from '@canopy/app-state';
import {
  OnboardingTip,
  type OnboardingTipProps,
} from '@canopy/ui-shared/components';

export type ComposerHintProps = Omit<
  OnboardingTipProps,
  'placement' | 'announce'
>;

/**
 * A tip the composer offers in response to the draft (plan mode, CAN-4008),
 * rather than on arrival. It is the same onboarding tip, a section of the
 * composer's top `ComposerDrawer`, announced politely and never focused.
 * The host decides when it shows and what its verb does. While it shows,
 * arrival tips hold until the user sends, so one tip is on screen at a time.
 */
export function ComposerHint(props: ComposerHintProps): JSX.Element {
  const client = useOptionalCanopyClient();
  return (
    <>
      {client !== null ? <HoldArrivalTips /> : null}
      <OnboardingTip {...props} placement="composer" announce />
    </>
  );
}

function HoldArrivalTips(): null {
  const holdForNotice = useOnboardingTipsStore((state) => state.holdForNotice);
  useEffect(() => holdForNotice(), [holdForNotice]);
  return null;
}
