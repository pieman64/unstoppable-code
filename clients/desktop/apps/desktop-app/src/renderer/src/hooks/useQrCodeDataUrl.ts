import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Rendered QR edge in device pixels: 2x the 160px display box, so the code
 * stays crisp on a HiDPI display.
 */
const QR_WIDTH_PX = 320;

interface EncodedQr {
  value: string;
  dataUrl: string;
}

/**
 * Encodes `value` as a QR code data URI, or `null` while encoding, when
 * `value` is `null`, or when encoding fails.
 *
 * The result is keyed to the value it encodes, so a QR code for a previous
 * value is never returned once `value` changes — the pairing QR must never
 * show a code that is no longer current (CAN-2938). Encoding options match
 * `useStoreQrCodes`, including the four-module quiet zone the QR spec needs
 * for reliable acquisition.
 */
export function useQrCodeDataUrl(value: string | null): string | null {
  const [encoded, setEncoded] = useState<EncodedQr | null>(null);

  useEffect(() => {
    if (value === null) return;
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 4, width: QR_WIDTH_PX })
      .then((dataUrl: string) => {
        if (!cancelled) setEncoded({ value, dataUrl });
      })
      .catch(() => {
        // No QR code; the manual code beside it still works.
        if (!cancelled) setEncoded(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [value]);

  return encoded !== null && encoded.value === value ? encoded.dataUrl : null;
}
