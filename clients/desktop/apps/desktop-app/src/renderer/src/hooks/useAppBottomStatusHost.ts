import { useEffect, useState } from 'react';

export const APP_BOTTOM_STATUS_HOST_ID = 'app-bottom-status-host';

export function useAppBottomStatusHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.getElementById(APP_BOTTOM_STATUS_HOST_ID));
  }, []);

  return host;
}
