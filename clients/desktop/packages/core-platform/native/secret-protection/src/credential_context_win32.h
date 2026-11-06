#ifndef CANOPY_CREDENTIAL_CONTEXT_H
#define CANOPY_CREDENTIAL_CONTEXT_H
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincred.h>

const char *credential_error(DWORD error);
const char *credential_context(const WCHAR *expected_sid);
const char *credential_mutex(const WCHAR *name, const WCHAR *sid, HANDLE *out);
#endif
