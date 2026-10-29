/**
 * A refusal the host can explain (CAN-3458), such as an organization-owned
 * chat shared into another organization. The dialog shows its message as-is;
 * any other invite failure keeps the generic retry copy, so a raw transport
 * error never reaches the user.
 *
 * It lives apart from the dialog so first-screen web code can build one
 * through `@canopy/ui-app/sharing/invite-teammate-refusal` without loading
 * the sharing barrel.
 */
export class InviteTeammateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteTeammateRefusal';
  }
}
