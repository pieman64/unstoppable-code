/* Test-only native outcome table, never loaded or staged by product. */
#include "credential_context_win32.h"
#include <string.h>
#include <sddl.h>
#include <stdlib.h>

int main(void) {
  struct { DWORD error; const char *expected; } cases[] = {
    { ERROR_NOT_FOUND, "absent" },
    { ERROR_ACCESS_DENIED, "denied" },
    { ERROR_PRIVILEGE_NOT_HELD, "denied" },
    { ERROR_NO_SUCH_LOGON_SESSION, "unsupported_session" },
    { ERROR_NO_LOGON_SERVERS, "unsupported_session" },
    { ERROR_NOT_SUPPORTED, "unsupported_session" },
    { ERROR_CALL_NOT_IMPLEMENTED, "unsupported_session" },
    { ERROR_INVALID_PARAMETER, "unavailable" },
    { ERROR_INVALID_DATA, "unavailable" },
    { ERROR_OUTOFMEMORY, "unavailable" },
    { ERROR_SUCCESS, "unavailable" },
  };
  size_t i;
  for (i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i)
    if (strcmp(credential_error(cases[i].error), cases[i].expected)) return 1;
  /* Actual thread impersonation must refuse before any credential mutation. */
  if (!ImpersonateSelf(SecurityImpersonation)) return 2;
  if (strcmp(credential_context(L"S-1-5-18"), "unsupported_session")) {
    RevertToSelf(); return 3;
  }
  if (!RevertToSelf()) return 4;
  if (strcmp(credential_context(L"S-1-5-18"), "denied")) return 5;
  return 0;
}
