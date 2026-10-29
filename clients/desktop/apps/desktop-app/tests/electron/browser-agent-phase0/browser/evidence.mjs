// S0.3 probe: turns the raw event slices recorded during one case into the
// evidence shape that vectors.mjs classifies. Pure; unit tested.
//
// "Attributed" always means "attributed to the tab under test": a
// webRequest/handler event whose webContentsId is that tab, or a gateway
// decision carrying that tab's lease token. Events with no webContentsId are
// kept as unattributed evidence; other tabs' events are ignored.

const HANDLER_KINDS = Object.freeze({
  'file-chooser': 'file-chooser',
  device: 'device',
  download: 'download',
  popup: 'popup',
  external: 'external',
  permission: 'permission',
});

const LEASED_CAPABILITY_OBSERVED =
  /(notifications:granted|geo:granted|media:granted|clipboard:resolved)/;

/**
 * @param {{
 *   spec: { tab: 'leased'|'control', handler?: string, query?: string },
 *   tabId: number,
 *   leaseToken: string|null,
 *   listener: Array<{ webContentsId: number|null, cancel: boolean, resourceType: string, reason: string }>,
 *   gateway: Array<{ decision: string, attribution: string|null, addressClass: string, kind: string, reason: string }>,
 *   handlers: Array<{ kind: string, decision: string, webContentsId: number|null, permission?: string }>,
 *   destinationHits: number,
 *   page: { exercised: boolean, outcome: string|null, error: string|null },
 * }} input
 */
export function extractEvidence(input) {
  const {
    spec,
    tabId,
    leaseToken,
    listener,
    gateway,
    handlers,
    destinationHits,
    page,
  } = input;
  const mine = (id) => id === tabId;
  const relevant = (id) => id === tabId || id === null || id === undefined;

  const listenerDenies = listener
    .filter((event) => event.cancel && relevant(event.webContentsId))
    .map((event) => ({
      attributed: mine(event.webContentsId),
      resourceType: event.resourceType,
      reason: event.reason,
    }));
  const gatewayDenies = gateway
    .filter((event) => event.decision === 'deny')
    .map((event) => ({
      attributed: leaseToken !== null && event.attribution === leaseToken,
      addressClass: event.addressClass,
      kind: event.kind,
      reason: event.reason,
    }));

  const kind = spec.handler ? HANDLER_KINDS[spec.handler] : undefined;
  const onlyNotifications = spec.query === 'only=notifications';
  const handlerEvents = kind
    ? handlers
        .filter((event) => event.kind === kind && relevant(event.webContentsId))
        .filter(
          (event) => !onlyNotifications || event.permission === 'notifications',
        )
        .map((event) => ({
          kind: event.kind,
          decision: event.decision,
          attributed: mine(event.webContentsId),
        }))
    : [];

  let unsupported = null;
  if (page.outcome === 'usb:unavailable')
    unsupported = 'navigator.usb is unavailable in this binary';

  return {
    exercised: page.exercised,
    unsupported,
    error: page.error,
    destinationHits,
    listenerDenies,
    gatewayDenies,
    handlerEvents,
    pageOutcome: page.outcome,
    handlerSatisfied: kind
      ? handlerSatisfied(
          spec,
          page.outcome,
          handlers.filter((event) => mine(event.webContentsId)),
        )
      : undefined,
  };
}

/**
 * Whether the observable side effect matches the expectation: a leased tab
 * never gets the capability, a control tab keeps it.
 */
export function handlerSatisfied(spec, outcome, own) {
  const leased = spec.tab === 'leased';
  const text = String(outcome ?? '');
  switch (spec.handler) {
    case 'popup': {
      const created = own.some(
        (event) => event.kind === 'popup' && event.decision === 'created',
      );
      return leased ? !created : created;
    }
    case 'download': {
      const completed = own.some(
        (event) => event.kind === 'download' && event.decision === 'completed',
      );
      return leased ? !completed : completed;
    }
    case 'file-chooser':
      return !text.startsWith('change:');
    case 'device':
      return text !== 'usb:resolved';
    case 'external':
      return !own.some(
        (event) => event.kind === 'external' && event.decision === 'allow',
      );
    case 'permission':
      return leased
        ? !LEASED_CAPABILITY_OBSERVED.test(text)
        : /notifications:granted/.test(text);
    default:
      return false;
  }
}

/**
 * Replaces credentials and the query string before a URL enters the report.
 * Nonces and ports stay; nothing in the probe carries user data, but the
 * report format should not normalise recording raw URLs.
 */
export function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = '';
    }
    if (url.search) url.search = `?[${url.searchParams.size} params]`;
    return url.href.slice(0, 300);
  } catch {
    return String(value).slice(0, 80);
  }
}
