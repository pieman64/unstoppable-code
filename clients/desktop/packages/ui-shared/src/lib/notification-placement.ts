/** Corner of the window that holds the in-app notification stack. */
export type InAppNotificationPlacement =
  | 'top-right'
  | 'bottom-right'
  | 'top-left'
  | 'bottom-left';

export interface InAppNotificationContainerOptions {
  /**
   * Start a top corner below the app header (48px plus an 8px gap), so the
   * stack never covers the header's buttons. Bottom corners are unaffected.
   */
  readonly clearHeader?: boolean;
}

/** Shared notification viewport placement for independent desktop windows. */
export function getInAppNotificationContainerClasses(
  placement: InAppNotificationPlacement,
  { clearHeader = false }: InAppNotificationContainerOptions = {},
): string {
  switch (placement) {
    case 'top-right':
      return clearHeader
        ? 'pointer-events-none fixed right-4 top-14 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2'
        : 'pointer-events-none fixed right-4 top-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2';
    case 'bottom-left':
      return 'pointer-events-none fixed bottom-4 left-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2';
    case 'top-left':
      return clearHeader
        ? 'pointer-events-none fixed left-4 top-14 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2'
        : 'pointer-events-none fixed left-4 top-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2';
    case 'bottom-right':
      return 'pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2';
  }
}
