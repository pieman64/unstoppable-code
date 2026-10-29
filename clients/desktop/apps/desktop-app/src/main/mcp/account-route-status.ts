/** Route-owned cloud auth status; never consults or mutates local OAuth tokens. */
const routes = new Map<
  string,
  {
    serverId: string;
    configId: string;
    cloudRouteId: string;
    reauthRequired: boolean;
  }
>();

export function registerAccountMcpRouteStatus(
  routeId: string,
  serverId: string,
  configId: string,
  cloudRouteId: string,
): void {
  routes.set(routeId, {
    serverId,
    configId,
    cloudRouteId,
    reauthRequired: false,
  });
}
export function setAccountMcpRouteReauthRequired(
  routeId: string,
  reauthRequired: boolean,
): void {
  const route = routes.get(routeId);
  if (route) route.reauthRequired = reauthRequired;
}
export function removeAccountMcpRouteStatus(routeId: string): void {
  routes.delete(routeId);
}
export function isAccountMcpReauthRequired(
  serverId: string,
  configId: string,
  cloudRouteId?: string,
): boolean {
  return Array.from(routes.values()).some(
    (route): boolean =>
      route.serverId === serverId &&
      route.configId === configId &&
      (cloudRouteId === undefined || route.cloudRouteId === cloudRouteId) &&
      route.reauthRequired,
  );
}
