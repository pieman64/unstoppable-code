// Offline migration only. No process or credential-store access.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <winternl.h>
#include <stddef.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
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

static bool mf_admit(mf_node *node, bool privacy) {
  if (!GetFileInformationByHandle(node->file, &node->info)) return false;
  node->stage = "attributes-or-case";
  DWORD attributes = node->info.dwFileAttributes;
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !mf_case_insensitive(node->file)) return false;
  // Readonly regular files are copied without changing the source. All other exclusions remain.
  if (attributes & ~(FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_NORMAL |
      FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED |
      ((attributes & FILE_ATTRIBUTE_DIRECTORY) ? 0 : FILE_ATTRIBUTE_READONLY))) return false;
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
  node->stage = "private-dacl";
  if (privacy && !mf_private(node)) return false;
  node->stage = "leaf-admitted";
  return true;
}

static bool mf_open_access(wchar_t *path, mf_node *node, DWORD access) {
  node->stage = "parent-custody";
  if (!mf_parents(path, node)) return false;
  node->stage = "leaf-open";
  node->file = CreateFileW(path, access | GENERIC_READ | READ_CONTROL, MF_SHARE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (node->file == INVALID_HANDLE_VALUE || !mf_admit(node, true)) return false;
  node->stage = "canonical-spelling";
  wchar_t actual[MF_LIMIT + 8];
  DWORD length = GetFinalPathNameByHandleW(node->file, actual, MF_LIMIT + 8, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length || length >= MF_LIMIT + 8 || wcsncmp(actual, L"\\\\?\\", 4) || wcscmp(actual + 4, path)) return false;
  return true;
}

static bool mf_open(wchar_t *path, mf_node *node) {
  return mf_open_access(path, node, 0);
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
  if (!mf_open(path, source)) return false;
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
  basic.FileAttributes = source->info.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY;
  if (!basic.FileAttributes) basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
  if (!SetFileInformationByHandle(target->file, FileBasicInfo, &basic, sizeof basic)) return false;
  if (source->info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) {
    FILE_BASIC_INFO readonly = {0};
    readonly.FileAttributes = source->info.dwFileAttributes;
    source->stage = "copy-readonly";
    if (!SetFileInformationByHandle(target->file, FileBasicInfo, &readonly, sizeof readonly)) return false;
  }
  source->stage = "copy-flush";
  return directory || FlushFileBuffers(target->file);
}

static napi_value mf_observation(napi_env env, mf_node *node) {
  if (!GetFileInformationByHandle(node->file, &node->info)) return NULL;
  if (!node->security && !mf_private(node)) return NULL;
  // NTFS IDs routinely exceed 2^53. Never project identity through a double.
  node->stage = "file-id-zero";
  uint64_t id = ((uint64_t)node->info.nFileIndexHigh << 32) | node->info.nFileIndexLow;
  if (!id) return NULL;
  LPWSTR sddl = NULL;
  // Normalize only inherited/protected provenance, not effective rights or spelling.
  PACL acl = NULL;
  BOOL present, defaulted;
  node->stage = "inspect-dacl";
  if (!GetSecurityDescriptorDacl(node->security, &present, &acl, &defaulted) || !present || !acl) return NULL;
  for (DWORD i = 0; i < acl->AceCount; i++) {
    ACE_HEADER *ace;
    if (!GetAce(acl, i, (void **)&ace)) return NULL;
    ace->AceFlags &= ~INHERITED_ACE;
  }
  node->stage = "normalize-security-descriptor";
  if (!SetSecurityDescriptorControl(node->security, SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ, SE_DACL_PROTECTED) ||
      !ConvertSecurityDescriptorToStringSecurityDescriptorW(node->security, SDDL_REVISION_1,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &sddl, NULL)) return NULL;
  napi_value value, result;
  napi_create_object(env, &result);
  napi_create_string_utf16(env, (char16_t *)sddl, wcslen(sddl), &value);
  napi_set_named_property(env, result, "security", value);
  LocalFree(sddl);
  napi_create_bigint_uint64(env, id, &value);
  napi_set_named_property(env, result, "ino", value);
  napi_create_uint32(env, node->info.dwVolumeSerialNumber, &value);
  napi_set_named_property(env, result, "dev", value);
  napi_create_uint32(env, node->info.dwFileAttributes, &value);
  napi_set_named_property(env, result, "attributes", value);
  uint64_t size = ((uint64_t)node->info.nFileSizeHigh << 32) | node->info.nFileSizeLow;
  napi_create_bigint_uint64(env, size, &value);
  napi_set_named_property(env, result, "size", value);
  uint64_t mtime = ((uint64_t)node->info.ftLastWriteTime.dwHighDateTime << 32) | node->info.ftLastWriteTime.dwLowDateTime;
  napi_create_bigint_uint64(env, mtime, &value);
  napi_set_named_property(env, result, "mtime", value);
  return result;
}

// Deletion is restricted to a journaled construction/publication root. Every
// descendant is opened relative to its retained parent, never by pathname.
typedef NTSTATUS(NTAPI *mf_nt_create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

static bool mf_remove_node(mf_node *node, mf_nt_create_fn create, wchar_t *path) {
  bool directory = (node->info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (directory) {
    BYTE *buffer = calloc(1, 65536);
    if (!buffer) return false;
    bool ok = false;
    for (;;) {
      node->stage = "remove-enumerate";
      if (!GetFileInformationByHandleEx(node->file, FileIdBothDirectoryRestartInfo, buffer, 65536)) {
        ok = GetLastError() == ERROR_NO_MORE_FILES;
        break;
      }
      bool found = false;
      DWORD offset = 0;
      for (;;) {
        FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)(buffer + offset);
        size_t header = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
        if (offset > 65536 - header || !entry->FileNameLength ||
            entry->FileNameLength % sizeof(wchar_t) ||
            entry->FileNameLength > 65536 - offset - header) goto finished;
        size_t chars = entry->FileNameLength / sizeof(wchar_t);
        bool dot = (chars == 1 && entry->FileName[0] == L'.') ||
          (chars == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.');
        if (!dot) {
          size_t length = wcslen(path);
          node->stage = "remove-child-name";
          if (length + 1 + chars >= MF_LIMIT) goto finished;
          for (size_t i = 0; i < chars; i++)
            if (entry->FileName[i] < 32 || entry->FileName[i] == L'\\' ||
                entry->FileName[i] == L'/' || entry->FileName[i] == L':') goto finished;
          if (entry->FileName[chars-1] == L'.' || entry->FileName[chars-1] == L' ') goto finished;
          path[length] = L'\\';
          wmemcpy(path + length + 1, entry->FileName, chars);
          path[length + 1 + chars] = 0;
          UNICODE_STRING name = { (USHORT)entry->FileNameLength, (USHORT)entry->FileNameLength, entry->FileName };
          OBJECT_ATTRIBUTES attributes = {0};
          attributes.Length = sizeof attributes;
          attributes.RootDirectory = node->file;
          attributes.ObjectName = &name;
          attributes.Attributes = 0x40; // OBJ_CASE_INSENSITIVE
          IO_STATUS_BLOCK io = {0};
          mf_node child = {0};
          child.stage = "remove-child-open";
          NTSTATUS status = create(&child.file, GENERIC_READ | READ_CONTROL | DELETE |
            FILE_WRITE_ATTRIBUTES | SYNCHRONIZE, &attributes, &io, NULL, 0,
            MF_SHARE, 1, 0x00200000 | 0x20 | 0x4000, NULL, 0);
          bool admitted = status >= 0 && child.file && child.file != INVALID_HANDLE_VALUE && mf_admit(&child, true);
          uint64_t id = ((uint64_t)child.info.nFileIndexHigh << 32) | child.info.nFileIndexLow;
          if (admitted && (child.info.dwVolumeSerialNumber != node->info.dwVolumeSerialNumber ||
              id != (uint64_t)entry->FileId.QuadPart)) {
            child.stage = "remove-child-replaced";
            admitted = false;
          }
          if (!admitted || !mf_remove_node(&child, create, path)) {
            snprintf(node->diagnostic, sizeof node->diagnostic, "%s", child.stage ? child.stage : "remove-child");
            node->stage = node->diagnostic;
            node->info = child.info;
            node->stream_failure = child.stream_failure;
            mf_close(&child);
            goto finished;
          }
          mf_close(&child);
          path[length] = 0;
          found = true;
        }
        if (!entry->NextEntryOffset) break;
        if (entry->NextEntryOffset < header + entry->FileNameLength ||
            entry->NextEntryOffset > 65536 - offset - header) goto finished;
        offset += entry->NextEntryOffset;
      }
      if (!found) { ok = true; break; }
    }
finished:
    free(buffer);
    if (!ok) return false;
  }
  // Only transaction-created entries under the retained recorded root reach here.
  if (node->info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) {
    FILE_BASIC_INFO basic = {0};
    basic.FileAttributes = node->info.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY;
    if (!basic.FileAttributes) basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
    node->stage = "remove-readonly";
    if (!SetFileInformationByHandle(node->file, FileBasicInfo, &basic, sizeof basic)) return false;
  }
  FILE_DISPOSITION_INFO disposition = { TRUE };
  node->stage = "remove-disposition";
  return SetFileInformationByHandle(node->file, FileDispositionInfo, &disposition, sizeof disposition) != 0;
}

static bool mf_remove(napi_env env, napi_value expected, wchar_t *path, mf_node *node) {
  if (!mf_open_access(path, node, DELETE | FILE_WRITE_ATTRIBUTES)) return false;
  node->stage = "remove-recorded-identity";
  char supplied[64], actual[64];
  size_t length = 0;
  uint64_t id = ((uint64_t)node->info.nFileIndexHigh << 32) | node->info.nFileIndexLow;
  snprintf(actual, sizeof actual, "%lu:%llu", (unsigned long)node->info.dwVolumeSerialNumber, (unsigned long long)id);
  if (!(node->info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      napi_get_value_string_utf8(env, expected, supplied, sizeof supplied, &length) != napi_ok ||
      length != strlen(actual) || memcmp(supplied, actual, length)) return false;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  mf_nt_create_fn create = ntdll ? (mf_nt_create_fn)GetProcAddress(ntdll, "NtCreateFile") : NULL;
  node->stage = "remove-native-relative-open";
  return create && mf_remove_node(node, create, path);
}

// FileRenameInfoEx can replace readonly/hidden leaves without changing them.
// Only the transaction's private copy is opened for writing/deletion.
static bool mf_replace(wchar_t *path, wchar_t *other, mf_node *source, mf_node *target) {
  if (!mf_open_access(path, source, DELETE) || !mf_open(other, target) ||
      (source->info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (target->info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      source->info.dwVolumeSerialNumber != target->info.dwVolumeSerialNumber) return false;
  size_t length = wcslen(other) * sizeof(wchar_t);
  struct mf_rename_info { DWORD flags; HANDLE root; DWORD length; WCHAR name[MF_LIMIT]; } rename_info = {0};
  rename_info.flags = 0x1 | 0x2 | 0x40; // replace, POSIX semantics, ignore readonly
  rename_info.length = (DWORD)length;
  memcpy(rename_info.name, other, length);
  // The admitted destination's parents remain pinned across replacement.
  CloseHandle(target->file);
  target->file = NULL;
  source->stage = "replace-private-copy";
  return SetFileInformationByHandle(source->file, (FILE_INFO_BY_HANDLE_CLASS)22,
    &rename_info, (DWORD)(offsetof(struct mf_rename_info, name) + length)) != 0;
}

napi_value migration_filesystem(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3], result = NULL;
  wchar_t action[MF_LIMIT] = {0}, path[MF_LIMIT] = {0}, other[MF_LIMIT] = {0};
  mf_node source = {0}, target = {0};
  bool ok = false;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) goto done;
  // Actions are short strings, not paths.
  size_t copied;
  if (napi_get_value_string_utf16(env, args[0], (char16_t *)action, MF_LIMIT, &copied) != napi_ok ||
      copied >= MF_LIMIT || !mf_string(env, args[1], path)) goto done;
  if (!wcscmp(action, L"mkdir")) ok = mf_mkdir(path, &target);
  else if (!wcscmp(action, L"remove") && argc == 3) ok = mf_remove(env, args[2], path, &source);
  else if (!wcscmp(action, L"replace") && argc == 3 && mf_string(env, args[2], other))
    ok = mf_replace(path, other, &source, &target);
  else if (!wcscmp(action, L"read")) {
    if (!mf_open(path, &source) ||
        (source.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
        source.info.nFileSizeHigh || source.info.nFileSizeLow > 16 * 1024 * 1024) goto done;
    DWORD size = source.info.nFileSizeLow, read = 0;
    void *bytes = NULL;
    if (napi_create_buffer(env, size, &bytes, &result) != napi_ok ||
        !ReadFile(source.file, bytes, size, &read, NULL) || read != size) goto done;
    ok = true;
  } else if (!wcscmp(action, L"inspect")) {
    if (!mf_open(path, &source)) goto done;
    result = mf_observation(env, &source);
    if (!result) goto done;
    ok = true;
  } else if (argc == 3 && mf_string(env, args[2], other) &&
      (!wcscmp(action, L"copy") || !wcscmp(action, L"finish")))
  {
    bool finish = !wcscmp(action, L"finish");
    ok = mf_copy(path, other, &source, &target, finish);
    if (ok && !(source.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
      result = mf_observation(env, &target);
      ok = result != NULL;
    }
  }
done:
  DWORD error = GetLastError();
  mf_close(&target);
  mf_close(&source);
  if (!ok) {
    char message[2048], utf8[MF_LIMIT * 4] = {0};
    WideCharToMultiByte(CP_UTF8, 0, path, -1, utf8, sizeof utf8, NULL, NULL);
    snprintf(message, sizeof message,
      "Unsupported or changed migration filesystem entry (%s, path=%s, attributes=0x%08lx, win32=%lu; local NTFS, private SID/DACL, canonical short non-reparse unlocked entries required).",
      source.stage ? source.stage : target.stage ? target.stage : "creation-or-arguments", utf8, (unsigned long)source.info.dwFileAttributes, (unsigned long)error);
    napi_throw_error(env, source.stream_failure || target.stream_failure
      ? "ERR_MIGRATION_FILESYSTEM_STREAMS" : "ERR_MIGRATION_FILESYSTEM", message);
    return NULL;
  }
  if (!result) napi_get_undefined(env, &result);
  return result;
}
