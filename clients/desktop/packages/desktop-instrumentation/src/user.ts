/**
 * A type alias rather than an interface: TypeScript grants object-literal
 * type aliases an implicit index signature, but never interfaces
 * (microsoft/TypeScript#15300), and `@datadog/browser-rum`'s `User` parameter
 * type is index-signed — the interface form fails `tsc` with "Index signature
 * for type 'string' is missing".
 *
 * Must also stay assignable to `RumUser` declared by the vendored
 * `patches/@datadog+electron-sdk+0.2.0.patch` type definitions: the main
 * process applies it through an untyped `setUser.call(...)` (see
 * `applyUserToSdk`), so a divergence there is not caught at compile time.
 */
export type DesktopInstrumentationUser = {
  id: string;
  name: string;
  email?: string;
};

/**
 * Builds the RUM user identity from the stable anonymous install id, shared by
 * the renderer (`@datadog/browser-rum` `setUser`) and the main process
 * (vendored `setUser` patch on `@datadog/electron-sdk`) so both surfaces
 * report the identical identity.
 *
 * `name` is a short derivative of the UUID, not new information: without
 * `usr.name`, the Datadog RUM UI labels every session "Public User", which
 * makes installs indistinguishable in session lists and user analytics.
 */
export function buildDesktopInstrumentationUser(
  id: string,
  email?: string,
): DesktopInstrumentationUser {
  const normalizedEmail = email?.trim();
  return {
    id,
    name: `anon-${id.slice(0, 8)}`,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
  };
}
