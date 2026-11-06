#include "credential_context_win32.h"
#include <sddl.h>
#include <aclapi.h>
#include <ntsecapi.h>
#include <stdlib.h>
#include <stdio.h>
#include <wchar.h>

const char *credential_error(DWORD error) {
  switch (error) {
    case ERROR_NOT_FOUND: return "absent";
    case ERROR_ACCESS_DENIED:
    case ERROR_PRIVILEGE_NOT_HELD: return "denied";
    case ERROR_NO_SUCH_LOGON_SESSION:
    case ERROR_NO_LOGON_SERVERS:
    case ERROR_NOT_SUPPORTED:
    case ERROR_CALL_NOT_IMPLEMENTED: return "unsupported_session";
    default: return "unavailable";
  }
}

/* Refuse thread impersonation, service/network tokens and unloaded profiles. */
const char *credential_context(const WCHAR *expected_sid) {
  HANDLE thread = NULL, token = NULL;
  TOKEN_STATISTICS stats;
  DWORD size = 0, user_size = 0, session = 0;
  TOKEN_USER *user = NULL;
  PSID expected = NULL;
  PSECURITY_LOGON_SESSION_DATA logon = NULL;
  HKEY profile = NULL;
  DWORD persistence[CRED_TYPE_MAXIMUM] = {0};
  const char *result = "unavailable";
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) {
    CloseHandle(thread);
    return "unsupported_session";
  }
  if (GetLastError() != ERROR_NO_TOKEN) return "denied";
  if (!ConvertStringSidToSidW(expected_sid, &expected)) return "denied";
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (!size || size > 65536) goto done;
  user_size = size;
  user = (TOKEN_USER *)calloc(1, user_size);
  if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)) goto done;
  if (!EqualSid(expected, user->User.Sid)) { result = "denied"; goto done; }
  if (!GetTokenInformation(token, TokenSessionId, &session, sizeof(session), &size) || !session) {
    result = "unsupported_session"; goto done;
  }
  if (!GetTokenInformation(token, TokenStatistics, &stats, sizeof(stats), &size)) goto done;
  if (LsaGetLogonSessionData(&stats.AuthenticationId, &logon) != 0 || !logon) {
    result = "unsupported_session"; goto done;
  }
  if (logon->LogonType != Interactive && logon->LogonType != RemoteInteractive &&
      logon->LogonType != CachedInteractive && logon->LogonType != CachedRemoteInteractive) {
    result = "unsupported_session"; goto done;
  }
  {
    LSTATUS profile_status = RegOpenKeyExW(HKEY_USERS, expected_sid, 0, KEY_READ, &profile);
    if (profile_status != ERROR_SUCCESS) {
      result = profile_status == ERROR_ACCESS_DENIED ? "denied" : "unsupported_session";
      goto done;
    }
  }
  if (!CredGetSessionTypes(CRED_TYPE_MAXIMUM, persistence)) {
    result = credential_error(GetLastError()); goto done;
  }
  result = persistence[CRED_TYPE_GENERIC] >= CRED_PERSIST_LOCAL_MACHINE
    ? "unknown" : "unsupported_session";
done:
  if (profile) RegCloseKey(profile);
  if (logon) LsaFreeReturnBuffer(logon);
  if (user) { SecureZeroMemory(user, user_size); free(user); }
  if (token) CloseHandle(token);
  if (expected) LocalFree(expected);
  return result;
}

/* Existing names are untrusted. Accept only the exact protected user-only DACL. */
const char *credential_mutex(const WCHAR *name, const WCHAR *sid, HANDLE *out) {
  WCHAR sddl[512];
  PSECURITY_DESCRIPTOR descriptor = NULL, observed = NULL;
  PSID expected = NULL, owner = NULL;
  PACL dacl = NULL;
  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision = 0;
  SECURITY_ATTRIBUTES attributes = { sizeof(SECURITY_ATTRIBUTES), NULL, FALSE };
  HANDLE mutex = NULL;
  const char *result = "denied";
  *out = NULL;
  if (swprintf_s(sddl, 512, L"O:%sD:P(A;;0x00120001;;;%s)", sid, sid) < 0 ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL) ||
      !ConvertStringSidToSidW(sid, &expected)) goto done;
  attributes.lpSecurityDescriptor = descriptor;
  mutex = CreateMutexExW(&attributes, name, 0, SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL);
  if (!mutex) {
    result = GetLastError() == ERROR_INVALID_HANDLE ? "denied" : credential_error(GetLastError());
    goto done;
  }
  if (GetSecurityInfo(mutex, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &dacl, NULL, &observed) != ERROR_SUCCESS || !owner || !EqualSid(owner, expected) ||
      !dacl || dacl->AceCount != 1 ||
      !GetSecurityDescriptorControl(observed, &control, &revision) || !(control & SE_DACL_PROTECTED)) goto done;
  {
    ACCESS_ALLOWED_ACE *ace = NULL;
    if (!GetAce(dacl, 0, (void **)&ace) || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        ace->Header.AceFlags != 0 || ace->Mask != (SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL) ||
        !EqualSid((PSID)&ace->SidStart, expected)) goto done;
  }
  *out = mutex;
  mutex = NULL;
  result = "ok";
done:
  if (mutex) CloseHandle(mutex);
  if (observed) LocalFree(observed);
  if (expected) LocalFree(expected);
  if (descriptor) LocalFree(descriptor);
  SecureZeroMemory(sddl, sizeof(sddl));
  return result;
}
