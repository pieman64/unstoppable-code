// ---------------------------------------------------------------------------
// Member profile read DTOs (web Portal member profile page).
//
// The web Portal exposes a read-only, GitHub-profile-style member profile at an
// org-scoped route. This module is the single source of truth for the
// serializable header shape that crosses the web API ⇄ browser boundary.
//
// READ DTO only. Stays dependency-free (no Node, Prisma, or React) so the web
// service and the browser can both import it. The optional `bio` / `links`
// fields are a forward-compat hook for a future self-edit surface; they require
// no migration today.
// ---------------------------------------------------------------------------

/** A reserved, future-editable external link on a member profile header. */
export interface MemberProfileLink {
  label: string;
  url: string;
}

/**
 * The header block for a member profile page. `id` is the subject's
 * `User.externalId` (a UUID), `role` is their role within the viewed org, and
 * `memberSinceIso` is the ISO timestamp of their `OrganizationUser.createdAt`.
 */
export interface MemberProfileHeader {
  /** Subject `User.externalId` (UUID). */
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  memberSinceIso: string;
  /** Reserved for a future self-edit surface; absent today. */
  bio?: string | null;
  /** Reserved for a future self-edit surface; absent today. */
  links?: ReadonlyArray<MemberProfileLink>;
}
