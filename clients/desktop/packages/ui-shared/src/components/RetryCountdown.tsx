'use client';

import { useEffect, useState, type JSX } from 'react';

export interface RetryCountdownProps {
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  exhausted: boolean;
}

/** Display a host-owned retry schedule; this component never dispatches work. */
export function RetryCountdown({
  attempt,
  maxAttempts,
  nextRetryAt,
  exhausted,
}: RetryCountdownProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextRetryAt === null || exhausted) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return (): void => clearInterval(timer);
  }, [nextRetryAt, exhausted]);
  const seconds =
    nextRetryAt === null
      ? 0
      : Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <>
      {exhausted
        ? `Gave up after ${attempt} of ${maxAttempts} attempts.`
        : `${seconds > 0 ? `Retrying in ${countdown}` : 'Retrying now'}, attempt ${attempt} of ${maxAttempts}.`}
    </>
  );
}
