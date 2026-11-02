/**
 * Files one apply may change, journal, record as applied, or lease. The
 * parent's file session reads each file to plan, rereads it before writing
 * and writes it: at most three requests a file, within one session.
 *
 * A leaf module, so storage validators can bound leases without importing the
 * broker (the broker imports storage through the v3 record codec).
 */
export const DELEGATION_APPLY_FILE_BOUND = 2048;
