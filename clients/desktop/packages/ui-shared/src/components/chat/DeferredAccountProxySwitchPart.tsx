'use client';

import { lazy, memo, Suspense, type JSX } from 'react';

const LazyAccountProxySwitchPart = lazy(async () => {
  const module = await import('./AccountProxySwitchLine');
  return { default: module.AccountProxySwitchPart };
});

/**
 * {@link AccountProxySwitchPart}, loaded when a transcript first shows one.
 * Only desktop sessions record account proxy switches, so the web chat routes,
 * whose first load is budgeted, render this instead of carrying the line.
 */
function DeferredAccountProxySwitchPartComponent({
  data,
}: {
  readonly data: unknown;
}): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyAccountProxySwitchPart data={data} />
    </Suspense>
  );
}

export const DeferredAccountProxySwitchPart = memo(
  DeferredAccountProxySwitchPartComponent,
);
