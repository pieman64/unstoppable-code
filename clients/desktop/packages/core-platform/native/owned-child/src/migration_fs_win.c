// Offline migration only. No process or credential-store access.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include "migration_fs_win.h"

// Long paths are deliberately refused until the entire repair composition is qualified.
#define MF_LIMIT 240
#define MF_SHARE FILE_SHARE_READ

typedef struct {
  HANDLE parents[MF_LIMIT];
  unsigned count;
  HANDLE file;
  const char *stage;
  bool stream_failure;
  char diagnostic[256];
  PSECURITY_DESCRIPTOR security;
  BY_HANDLE_FILE_INFORMATION info;
} mf_node;

static void mf_close(mf_node *node) {
  if (node->file && node->file != INVALID_HANDLE_VALUE) CloseHandle(node->file);
  for (unsigned i = 0; i < node->count; i++) CloseHandle(node->parents[i]);
  if (node->security) LocalFree(node->security);
}

static bool mf_string(napi_env env, napi_value value, wchar_t *out) {
  size_t length = 0, copied = 0;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      !length || length >= MF_LIMIT ||
      napi_get_value_string_utf16(env, value, (char16_t *)out, MF_LIMIT, &copied) != napi_ok ||
      copied != length || wcslen(out) != length) return false;
  // Native canonical drive paths only, not UNC, device namespaces, ADS or aliases.
  if (!((out[0] >= L'A' && out[0] <= L'Z') || (out[0] >= L'a' && out[0] <= L'z')) ||
      out[1] != L':' || out[2] != L'\\') return false;
  for (size_t i = 3; i < length; i++) {
    if (out[i] == L'/' || out[i] == L':' || out[i] < 32) return false;
    if ((out[i] == L'.' || out[i] == L' ') && (out[i+1] == L'\\' || !out[i+1])) return false;
    if (out[i] == L'\\' && (i == 3 || out[i-1] == L'\\')) return false;
  }
  return true;
}

static bool mf_case_insensitive(HANDLE directory) {
  struct { ULONG flags; } info;
  // FileCaseSensitiveInfo (Windows 10+); pathname membership is deliberately
  // conservative/insensitive, so case-sensitive NTFS directories are unsupported.
  return GetFileInformationByHandleEx(directory, (FILE_INFO_BY_HANDLE_CLASS)23,
    &info, sizeof info) && info.flags == 0;
}

static bool mf_volume(const wchar_t *path) {
  wchar_t drive[] = L"C:\\", format[32];
  drive[0] = path[0];
  return GetDriveTypeW(drive) == DRIVE_FIXED &&
    GetVolumeInformationW(drive, NULL, 0, NULL, NULL, NULL, format, 32) &&
    wcscmp(format, L"NTFS") == 0;
}

// Parents stay open without delete sharing until the operation finishes. This
// prevents an ancestor rename/reparse swap between checking and using the leaf.
static bool mf_parents(wchar_t *path, mf_node *node) {
  if (!mf_volume(path)) return false;
  for (unsigned i = 3; path[i]; i++) {
    if (path[i] != L'\\') continue;
    path[i] = 0;
    HANDLE h = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    path[i] = L'\\';
    BY_HANDLE_FILE_INFORMATION info;
    if (h == INVALID_HANDLE_VALUE) return false;
    node->parents[node->count++] = h;
    if (!GetFileInformationByHandle(h, &info) ||
        !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || !mf_case_insensitive(h)) return false;
  }
  return true;
}

static bool mf_acl_failure(mf_node *node, const char *reason, DWORD control,
    int index, ACE_HEADER *ace, DWORD mask, const char *trustee) {
  snprintf(node->diagnostic, sizeof node->diagnostic,
    "private-dacl:%s control=0x%04lx protected=%u ace=%d type=%d flags=0x%02x mask=0x%08lx trustee=%s",
    reason, (unsigned long)control, !!(control & SE_DACL_PROTECTED), index,
    ace ? (int)ace->AceType : -1, ace ? ace->AceFlags : 0,
    (unsigned long)mask, trustee);
  node->stage = node->diagnostic;
  return false;
}

static bool mf_private(mf_node *node) {
  PSID owner = NULL;
  PACL acl = NULL;
  HANDLE token = NULL;
  DWORD size = 0;
  bool valid = false;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  DWORD error = GetSecurityInfo(node->file, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &acl, NULL, &node->security);
  if (error != ERROR_SUCCESS) {
    SetLastError(error);
    return mf_acl_failure(node, "read-security", control, -1, NULL, 0, "unknown");
  }
  if (!GetSecurityDescriptorControl(node->security, &control, &revision))
    return mf_acl_failure(node, "descriptor-control", control, -1, NULL, 0, "unknown");
  if (!(control & SE_DACL_PRESENT) || !acl)
    return mf_acl_failure(node, "null-or-absent-dacl", control, -1, NULL, 0, "everyone");
  if (!IsValidAcl(acl))
    return mf_acl_failure(node, "invalid-dacl", control, -1, NULL, 0, "unknown");
  if (!owner || !IsValidSid(owner))
    return mf_acl_failure(node, "invalid-owner", control, -1, NULL, 0, "unknown");
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return mf_acl_failure(node, "open-token", control, -1, NULL, 0, "unknown");
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = malloc(size);
  if (!user) {
    CloseHandle(token);
    return mf_acl_failure(node, "token-allocation", control, -1, NULL, 0, "unknown");
  }
  if (!GetTokenInformation(token, TokenUser, user, size, &size)) {
    mf_acl_failure(node, "token-user", control, -1, NULL, 0, "unknown");
    goto done;
  }
  if (!EqualSid(owner, user->User.Sid)) {
    mf_acl_failure(node, "owner-mismatch", control, -1, NULL, 0, "foreign-owner");
    goto done;
  }
  for (DWORD i = 0; i < acl->AceCount; i++) {
    ACE_HEADER *ace = NULL;
    if (!GetAce(acl, i, (void **)&ace)) {
      mf_acl_failure(node, "read-ace", control, (int)i, NULL, 0, "unknown");
      goto done;
    }
    if (ace->AceType != ACCESS_ALLOWED_ACE_TYPE && ace->AceType != ACCESS_DENIED_ACE_TYPE) {
      mf_acl_failure(node, "unsupported-ace", control, (int)i, ace, 0, "unknown");
      goto done;
    }
    ACCESS_ALLOWED_ACE *allowed = (ACCESS_ALLOWED_ACE *)ace;
    PSID sid = &allowed->SidStart;
    if (ace->AceSize < sizeof(ACCESS_ALLOWED_ACE) || !IsValidSid(sid)) {
      mf_acl_failure(node, "invalid-trustee", control, (int)i, ace, 0, "invalid");
      goto done;
    }
    if (ace->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (!EqualSid(sid, user->User.Sid) && !IsWellKnownSid(sid, WinLocalSystemSid) &&
        !IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) {
      mf_acl_failure(node, "foreign-grant", control, (int)i, ace, allowed->Mask, "foreign");
      goto done;
    }
  }
  // Match secure-files/windows-acl: privileged trustees do not widen access.
  // Source directories need not grant inheritable full control.
  valid = true;
done:
  free(user);
  CloseHandle(token);
  return valid;
}

static bool mf_open(wchar_t *path, mf_node *node, bool privacy) {
  node->stage = "parent-custody";
  if (!mf_parents(path, node)) return false;
  node->stage = "leaf-open";
  node->file = CreateFileW(path, GENERIC_READ | READ_CONTROL, MF_SHARE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (node->file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(node->file, &node->info)) return false;
  node->stage = "attributes-or-case";
  DWORD attributes = node->info.dwFileAttributes;
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !mf_case_insensitive(node->file)) return false;
  // Refuse read-only, reparse/junction, sparse, encrypted, offline and compressed entries.
  if (attributes & ~(FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_NORMAL |
      FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)) return false;
  bool directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (!directory && node->info.nNumberOfLinks != 1) return false;
  node->stage = directory ? "directory-streams" : "file-streams";
  node->stream_failure = true;
  BYTE streams[65536] = {0};
  bool queried = GetFileInformationByHandleEx(node->file, FileStreamInfo, streams, sizeof streams) != 0;
  bool no_data = directory || (!node->info.nFileSizeHigh && !node->info.nFileSizeLow);
  // Directories have no unnamed stream; NTFS may also omit it for empty files.
  if (!queried && !(no_data && GetLastError() == ERROR_HANDLE_EOF)) return false;
  FILE_STREAM_INFO *stream = (FILE_STREAM_INFO *)streams;
  if (stream->NextEntryOffset ||
      !(no_data && stream->StreamNameLength == 0) &&
      (stream->StreamNameLength != 7 * sizeof(wchar_t) ||
       wcsncmp(stream->StreamName, L"::$DATA", 7))) return false;
  node->stream_failure = false;
  node->stage = "canonical-spelling";
  wchar_t actual[MF_LIMIT + 8];
  DWORD length = GetFinalPathNameByHandleW(node->file, actual, MF_LIMIT + 8, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  // Exact observed spelling, not lowercasing an authority identity.
  if (!length || length >= MF_LIMIT + 8 || wcsncmp(actual, L"\\\\?\\", 4) || wcscmp(actual + 4, path)) return false;
  node->stage = "private-dacl";
  if (privacy && !mf_private(node)) return false;
  node->stage = "leaf-admitted";
  return true;
}

static bool mf_mkdir(wchar_t *path, mf_node *target) {
  target->stage = "mkdir-parent-custody";
  if (!mf_parents(path, target)) return false;
  target->stage = "mkdir-private-security";
  HANDLE token = NULL;
  DWORD size = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = malloc(size);
  LPWSTR sid = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  bool ok = false;
  if (user && GetTokenInformation(token, TokenUser, user, size, &size) &&
      ConvertSidToStringSidW(user->User.Sid, &sid)) {
    wchar_t sddl[512];
    if (swprintf(sddl, 512, L"O:%lsD:P(A;OICI;FA;;;%ls)", sid, sid) > 0 &&
        ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL)) {
      SECURITY_ATTRIBUTES security = { sizeof security, descriptor, FALSE };
      target->stage = "mkdir-create";
      ok = CreateDirectoryW(path, &security) != 0;
    }
  }
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  free(user);
  CloseHandle(token);
  return ok;
}

static bool mf_copy(wchar_t *path, wchar_t *other, mf_node *source, mf_node *target, bool finish) {
  if (!mf_open(path, source, true)) return false;
  source->stage = "copy-parent-custody";
  if (!mf_parents(other, target)) return false;
  bool directory = (source->info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  // Protect the copied source DACL from the construction parent's inheritance.
  source->stage = "copy-protect-security";
  if (!SetSecurityDescriptorControl(source->security, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) return false;
  SECURITY_ATTRIBUTES security = { sizeof security, source->security, FALSE };
  source->stage = "copy-create";
  if (directory && !finish) return CreateDirectoryW(other, &security) != 0;
  target->file = CreateFileW(other, GENERIC_WRITE | READ_CONTROL | WRITE_DAC,
    0, &security, (finish || directory) ? OPEN_EXISTING : CREATE_NEW,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (target->file == INVALID_HANDLE_VALUE) return false;
  source->stage = "copy-target-shape";
  BY_HANDLE_FILE_INFORMATION opened;
  if (!GetFileInformationByHandle(target->file, &opened) ||
      (opened.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !!(opened.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) return false;
  if (!directory && !finish) {
    source->stage = "copy-bytes";
    char buffer[65536];
    DWORD read = 0, written = 0;
    do {
      if (!ReadFile(source->file, buffer, sizeof buffer, &read, NULL)) return false;
      if (read && (!WriteFile(target->file, buffer, read, &written, NULL) || written != read)) return false;
    } while (read);
  }
  PACL copied_acl = NULL;
  BOOL acl_present, acl_defaulted;
  source->stage = "copy-acl";
  if (!GetSecurityDescriptorDacl(source->security, &acl_present, &copied_acl, &acl_defaulted) ||
      !acl_present || !copied_acl ||
      SetSecurityInfo(target->file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, copied_acl, NULL) != ERROR_SUCCESS) return false;
  FILE_BASIC_INFO basic = {0};
  source->stage = "copy-metadata";
  basic.CreationTime.LowPart = source->info.ftCreationTime.dwLowDateTime;
  basic.CreationTime.HighPart = source->info.ftCreationTime.dwHighDateTime;
  basic.LastAccessTime.LowPart = source->info.ftLastAccessTime.dwLowDateTime;
  basic.LastAccessTime.HighPart = source->info.ftLastAccessTime.dwHighDateTime;
  basic.LastWriteTime.LowPart = source->info.ftLastWriteTime.dwLowDateTime;
  basic.LastWriteTime.HighPart = source->info.ftLastWriteTime.dwHighDateTime;
  basic.FileAttributes = source->info.dwFileAttributes;
  if (!SetFileInformationByHandle(target->file, FileBasicInfo, &basic, sizeof basic)) return false;
  source->stage = "copy-flush";
  return directory || FlushFileBuffers(target->file);
}

napi_value migration_filesystem(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3], result = NULL;
  wchar_t action[MF_LIMIT], path[MF_LIMIT], other[MF_LIMIT];
  mf_node source = {0}, target = {0};
  bool ok = false;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) goto done;
  // Actions are short strings, not paths.
  size_t copied;
  if (napi_get_value_string_utf16(env, args[0], (char16_t *)action, MF_LIMIT, &copied) != napi_ok ||
      copied >= MF_LIMIT || !mf_string(env, args[1], path)) goto done;
  if (!wcscmp(action, L"mkdir")) ok = mf_mkdir(path, &target);
  else if (!wcscmp(action, L"read")) {
    if (!mf_open(path, &source, true) ||
        (source.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
        source.info.nFileSizeHigh || source.info.nFileSizeLow > 16 * 1024 * 1024) goto done;
    DWORD size = source.info.nFileSizeLow, read = 0;
    void *bytes = NULL;
    if (napi_create_buffer(env, size, &bytes, &result) != napi_ok ||
        !ReadFile(source.file, bytes, size, &read, NULL) || read != size) goto done;
    ok = true;
  } else if (!wcscmp(action, L"inspect")) {
    if (!mf_open(path, &source, true)) goto done;
    // NTFS IDs routinely exceed 2^53. Never project identity through a double.
    source.stage = "file-id-zero";
    uint64_t id = ((uint64_t)source.info.nFileIndexHigh << 32) | source.info.nFileIndexLow;
    if (!id) goto done;
    LPWSTR sddl = NULL;
    // Normalize only inherited/protected provenance, not effective rights or spelling.
    PACL acl = NULL;
    BOOL present, defaulted;
    source.stage = "inspect-dacl";
    if (!GetSecurityDescriptorDacl(source.security, &present, &acl, &defaulted) || !present || !acl) goto done;
    for (DWORD i = 0; i < acl->AceCount; i++) {
      ACE_HEADER *ace;
      if (!GetAce(acl, i, (void **)&ace)) goto done;
      ace->AceFlags &= ~INHERITED_ACE;
    }
    source.stage = "normalize-security-descriptor";
    if (!SetSecurityDescriptorControl(source.security, SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ, SE_DACL_PROTECTED) ||
        !ConvertSecurityDescriptorToStringSecurityDescriptorW(source.security, SDDL_REVISION_1,
          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &sddl, NULL)) goto done;
    napi_value value;
    napi_create_object(env, &result);
    napi_create_string_utf16(env, (char16_t *)sddl, wcslen(sddl), &value);
    napi_set_named_property(env, result, "security", value);
    LocalFree(sddl);
    napi_create_bigint_uint64(env, id, &value);
    napi_set_named_property(env, result, "ino", value);
    napi_create_uint32(env, source.info.dwVolumeSerialNumber, &value);
    napi_set_named_property(env, result, "dev", value);
    napi_create_uint32(env, source.info.dwFileAttributes, &value);
    napi_set_named_property(env, result, "attributes", value);
    ok = true;
  } else if (argc == 3 && mf_string(env, args[2], other) &&
      (!wcscmp(action, L"copy") || !wcscmp(action, L"finish")))
    ok = mf_copy(path, other, &source, &target, !wcscmp(action, L"finish"));
done:
  DWORD error = GetLastError();
  mf_close(&target);
  mf_close(&source);
  if (!ok) {
    char message[640];
    snprintf(message, sizeof message,
      "Unsupported or changed migration filesystem entry (%s, win32=%lu; local NTFS, private SID/DACL, canonical short non-reparse writable unlocked entries required).",
      source.stage ? source.stage : target.stage ? target.stage : "creation-or-arguments", (unsigned long)error);
    napi_throw_error(env, source.stream_failure || target.stream_failure
      ? "ERR_MIGRATION_FILESYSTEM_STREAMS" : "ERR_MIGRATION_FILESYSTEM", message);
    return NULL;
  }
  if (!result) napi_get_undefined(env, &result);
  return result;
}
