import type { JSX, ReactNode } from 'react';

/**
 * A plan diagram's empty, generating and failed states: the message centered
 * in the diagram's frame. Shared by the sequence, logic and data model views.
 */
export function DiagramCenteredMessage({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      {children}
    </div>
  );
}
