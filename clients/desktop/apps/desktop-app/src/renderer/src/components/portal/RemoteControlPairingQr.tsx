import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { pairingMachineLabel } from '@/components/portal/pairingMachineLabel';

/**
 * The primary Remote Control pairing affordance (CAN-2938): a QR code that a
 * phone's camera opens in the browser, with one line saying what scanning it
 * does. The caller renders the 6-digit code beneath as the manual fallback.
 *
 * The tile is white in both color modes: a QR code inverted by a dark surface
 * is unreliable for phone cameras (same rule as `MobileAppQrPromo`).
 */
export function RemoteControlPairingQr({
  qrSrc,
  machineName,
}: {
  qrSrc: string;
  machineName: string | null;
}): JSX.Element {
  const machine = pairingMachineLabel(machineName);
  return (
    <div
      className="flex flex-col items-center gap-3"
      data-testid="canopy-portal-pairing-qr"
    >
      <div className="rounded-lg bg-white p-2">
        <img
          src={qrSrc}
          alt={`QR code to connect ${machine} to ${REMOTE_CONTROL_LABEL}`}
          className="h-40 w-40"
          draggable={false}
          data-testid="canopy-portal-pairing-qr-image"
        />
      </div>
      <p
        className="text-s font-medium fg-primary"
        data-testid="canopy-portal-pairing-qr-instruction"
      >
        {`Scan with your phone's camera to connect ${machine}.`}
      </p>
    </div>
  );
}
