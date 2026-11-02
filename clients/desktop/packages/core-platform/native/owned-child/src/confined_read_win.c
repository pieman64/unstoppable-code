// Handle-confined reads of W5 capture files (CAN-5202, Windows).
//
// The trusted root is opened by its resolved path without following a final
// reparse point, and that handle's final path must be exactly the root, so an
// ancestor swapped in after the caller resolved the root is refused as
// `root-changed`, and a root that no longer opens as `root-unavailable`;
// both are root-level, so the caller refuses the whole capture. Each
// later component is opened with NtCreateFile relative to its parent's
// handle, one name at a time, with FILE_OPEN_REPARSE_POINT: renaming or
// replacing an ancestor cannot redirect the walk, and a symlink, junction,
// mount point or any other reparse point is refused, never followed. Before
// any byte is read, the file handle's final path must still be the intended
// in-root path, as Linux checks its descriptor. One no longer under the
// root's path at all means the root, an ancestor or a directory below it
// moved mid-walk, and is `root-changed` too. Every handle shares read, write
// and delete, so a capture never blocks a writer's atomic replace. Results
// carry no paths or error text.
#ifndef _WIN32
#error "core-owned-child (Windows) supports Windows only"
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <winternl.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include <node_api.h>

#include "confined_read_win.h"

#ifndef OBJ_CASE_INSENSITIVE
#define OBJ_CASE_INSENSITIVE 0x00000040L
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_SEQUENTIAL_ONLY
#define FILE_SEQUENTIAL_ONLY 0x00000004
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif

// NTSTATUS values, named here: ntstatus.h conflicts with windows.h.
#define CR_STATUS_STOPPED_ON_SYMLINK 0x8000002DUL
#define CR_STATUS_NO_SUCH_FILE 0xC000000FUL
#define CR_STATUS_OBJECT_NAME_NOT_FOUND 0xC0000034UL
#define CR_STATUS_OBJECT_PATH_NOT_FOUND 0xC000003AUL
#define CR_STATUS_REPARSE_POINT_ENCOUNTERED 0xC000050BUL

// A workspace directory and its file; a capture needs at most two.
#define CR_MAX_COMPONENTS 4
#define CR_MAX_NAME_CHARS 255
// Leaves room for the `\\?\UNC\` prefix and the components within 32767.
#define CR_MAX_ROOT_CHARS 30000
// Above the capture's own 8 MiB bound; the caller passes what remains of it.
#define CR_MAX_BYTES (64u * 1024u * 1024u)
#define CR_SHARE_ALL (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)

typedef NTSTATUS(NTAPI *nt_create_file_fn)(PHANDLE, ACCESS_MASK,
                                           POBJECT_ATTRIBUTES,
                                           PIO_STATUS_BLOCK, PLARGE_INTEGER,
                                           ULONG, ULONG, ULONG, ULONG, PVOID,
                                           ULONG);

typedef enum {
  CR_PRESENT,
  CR_ABSENT,
  CR_UNSAFE,
  CR_NOT_FILE,
  CR_IO,
  CR_TOO_LARGE,
  // The root, not one file: the caller refuses the whole capture.
  CR_ROOT_UNAVAILABLE,
  CR_ROOT_CHANGED
} cr_state;

typedef enum { CR_FILE, CR_DIRECTORY, CR_REPARSE, CR_OTHER, CR_UNKNOWN } cr_kind;

// CR_RENAMED: still under the root's path; CR_ELSEWHERE: not under it.
typedef enum { CR_NAMED, CR_RENAMED, CR_ELSEWHERE, CR_UNNAMED } cr_name;

typedef struct {
  wchar_t *text;
  size_t length;
} cr_string;

// Copies a JS string as UTF-16 without embedded NULs. Returns false with no
// exception pending.
static bool cr_copy_string(napi_env env, napi_value value, size_t maximum,
                           cr_string *out) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, NULL, 0, &size) != napi_ok ||
      size == 0 || size > maximum)
    return false;
  char16_t *text = calloc(size + 1, sizeof *text);
  if (!text) return false;
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, text, size + 1, &copied) !=
          napi_ok ||
      copied != size || wcslen((const wchar_t *)text) != size) {
    free(text);
    return false;
  }
  out->text = (wchar_t *)text;
  out->length = size;
  return true;
}

// One plain name: no separators, stream or device syntax, and no trailing
// dot, which also excludes `.` and `..`.
static bool cr_valid_name(const cr_string *name) {
  if (name->text[name->length - 1] == L'.') return false;
  for (size_t at = 0; at < name->length; at++) {
    wchar_t c = name->text[at];
    if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
          (c >= L'0' && c <= L'9') || c == L'.' || c == L'_' || c == L'-'))
      return false;
  }
  return true;
}

// A drive (`C:\...`) or UNC (`\\server\share...`) path as Node's realpath
// returns it: backslashes only, no `\\?\` or `\\.\` device prefix. The root
// handle's final-path check refuses any other spelling.
static bool cr_valid_root(const cr_string *root) {
  const wchar_t *text = root->text;
  if (wcschr(text, L'/')) return false;
  wchar_t drive = (wchar_t)(text[0] | 0x20);
  if (root->length >= 3 && drive >= L'a' && drive <= L'z' && text[1] == L':' &&
      text[2] == L'\\')
    return true;
  return root->length > 4 && text[0] == L'\\' && text[1] == L'\\' &&
         text[2] != L'?' && text[2] != L'.' && text[2] != L'\\';
}

// `\\?\` + root (`\\?\UNC\` for a UNC root), as GetFinalPathNameByHandleW
// names it, then each component. `root_chars` receives the root's length.
static wchar_t *cr_expected_path(const cr_string *root, const cr_string *names,
                                 size_t count, size_t *root_chars,
                                 size_t *total_chars) {
  bool unc = root->text[1] == L'\\';
  const wchar_t *prefix = unc ? L"\\\\?\\UNC\\" : L"\\\\?\\";
  const wchar_t *tail = unc ? root->text + 2 : root->text;
  size_t prefix_length = wcslen(prefix);
  size_t tail_length = unc ? root->length - 2 : root->length;
  size_t capacity = prefix_length + tail_length + 1;
  for (size_t at = 0; at < count; at++) capacity += names[at].length + 1;
  wchar_t *path = calloc(capacity, sizeof *path);
  if (!path) return NULL;
  size_t length = 0;
  wmemcpy(path + length, prefix, prefix_length);
  length += prefix_length;
  wmemcpy(path + length, tail, tail_length);
  length += tail_length;
  *root_chars = length;
  for (size_t at = 0; at < count; at++) {
    if (path[length - 1] != L'\\') path[length++] = L'\\';
    wmemcpy(path + length, names[at].text, names[at].length);
    length += names[at].length;
  }
  path[length] = 0;
  *total_chars = length;
  return path;
}

static nt_create_file_fn cr_nt_create_file(void) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  return ntdll ? (nt_create_file_fn)GetProcAddress(ntdll, "NtCreateFile")
               : NULL;
}

static cr_kind cr_inspect(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                    sizeof tag))
    return CR_UNKNOWN;
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return CR_REPARSE;
  if (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) return CR_DIRECTORY;
  return GetFileType(handle) == FILE_TYPE_DISK ? CR_FILE : CR_OTHER;
}

// The handle's normalized final path, or NULL. A path that grew between the
// two calls is NULL too.
static wchar_t *cr_final_path(HANDLE handle, size_t hint, size_t *length) {
  DWORD capacity = (DWORD)hint + 2;
  for (int attempt = 0; attempt < 2; attempt++) {
    wchar_t *path = calloc(capacity, sizeof *path);
    if (!path) return NULL;
    DWORD got = GetFinalPathNameByHandleW(handle, path, capacity,
                                          FILE_NAME_NORMALIZED |
                                              VOLUME_NAME_DOS);
    if (got > 0 && got < capacity) {
      *length = got;
      return path;
    }
    free(path);
    // Too small: `got` is the size needed, with its terminator.
    if (got == 0) return NULL;
    capacity = got;
  }
  return NULL;
}

// Whether the handle's normalized final path is exactly `expected`, and if
// not, whether it is still under its first `root_chars`, the root's path.
static cr_name cr_handle_named(HANDLE handle, const wchar_t *expected,
                               size_t length, size_t root_chars) {
  size_t got = 0;
  wchar_t *actual = cr_final_path(handle, length, &got);
  if (!actual) return CR_UNNAMED;
  cr_name result;
  if (got == length && wmemcmp(actual, expected, length) == 0)
    result = CR_NAMED;
  else if (got > root_chars && wmemcmp(actual, expected, root_chars) == 0 &&
           (expected[root_chars - 1] == L'\\' || actual[root_chars] == L'\\'))
    result = CR_RENAMED;
  else
    result = CR_ELSEWHERE;
  free(actual);
  return result;
}

// Opens one name relative to `parent`, never following a reparse point.
static NTSTATUS cr_open_child(nt_create_file_fn create, HANDLE parent,
                              const cr_string *name, bool file,
                              HANDLE *out) {
  UNICODE_STRING object_name;
  object_name.Buffer = name->text;
  object_name.Length = (USHORT)(name->length * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  OBJECT_ATTRIBUTES attributes;
  memset(&attributes, 0, sizeof attributes);
  attributes.Length = sizeof attributes;
  attributes.RootDirectory = parent;
  attributes.ObjectName = &object_name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK io;
  memset(&io, 0, sizeof io);
  HANDLE handle = NULL;
  NTSTATUS status = create(
      &handle,
      (file ? FILE_READ_DATA : FILE_TRAVERSE) | FILE_READ_ATTRIBUTES |
          SYNCHRONIZE,
      &attributes, &io, NULL, 0, CR_SHARE_ALL, FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
          (file ? FILE_SEQUENTIAL_ONLY : 0),
      NULL, 0);
  *out = status >= 0 && handle ? handle : INVALID_HANDLE_VALUE;
  return status;
}

static cr_state cr_open_failure(NTSTATUS status) {
  switch ((ULONG)status) {
    case CR_STATUS_NO_SUCH_FILE:
    case CR_STATUS_OBJECT_NAME_NOT_FOUND:
    case CR_STATUS_OBJECT_PATH_NOT_FOUND:
      return CR_ABSENT;
    case CR_STATUS_STOPPED_ON_SYMLINK:
    case CR_STATUS_REPARSE_POINT_ENCOUNTERED:
      return CR_UNSAFE;
    default:
      return CR_IO;
  }
}

// A file no longer under the root's path was reached while the root, or
// something above it, was moved: root-level, even if the root is back by the
// time it is checked again. A rename within the root is that file's own.
static cr_state cr_name_failure(cr_name name) {
  switch (name) {
    case CR_RENAMED:
      return CR_UNSAFE;
    case CR_ELSEWHERE:
      return CR_ROOT_CHANGED;
    default:
      return CR_IO;
  }
}

// Reads at most `maximum` bytes; one more means the file is too large, even
// if it grew after its size was read.
static cr_state cr_read_all(HANDLE file, uint32_t maximum, uint8_t **out,
                            size_t *out_size) {
  LARGE_INTEGER size;
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0) return CR_IO;
  if ((uint64_t)size.QuadPart > maximum) return CR_TOO_LARGE;
  size_t capacity = (size_t)size.QuadPart + 1;
  size_t length = 0;
  uint8_t *data = malloc(capacity);
  if (!data) return CR_IO;
  for (;;) {
    if (length == capacity) {
      if (capacity > maximum) {
        free(data);
        return CR_TOO_LARGE;
      }
      size_t next = capacity * 2;
      if (next > (size_t)maximum + 1) next = (size_t)maximum + 1;
      uint8_t *grown = realloc(data, next);
      if (!grown) {
        free(data);
        return CR_IO;
      }
      data = grown;
      capacity = next;
    }
    DWORD got = 0;
    if (!ReadFile(file, data + length, (DWORD)(capacity - length), &got,
                  NULL)) {
      free(data);
      return CR_IO;
    }
    if (got == 0) break;
    length += got;
  }
  if (length > maximum) {
    free(data);
    return CR_TOO_LARGE;
  }
  *out = data;
  *out_size = length;
  return CR_PRESENT;
}

// A root handle that no longer names the root makes any per-file outcome
// meaningless: the walk ran in a directory moved away or deleted.
static cr_state cr_root_failure(cr_name name) {
  return name == CR_UNNAMED ? CR_ROOT_UNAVAILABLE : CR_ROOT_CHANGED;
}

// Every failure to open or name the root is root-level, never one file's
// absence: the caller resolved the root just before, so it moved or vanished.
// The root handle stays open for the walk, and any per-file outcome but
// `present` is checked against it again, so a root moved mid-walk is not
// misreported as a file's absence or unsafety. A file outside the root's path
// is root-level without that check, which a root moved and back could pass.
static cr_state cr_read(const wchar_t *root, size_t root_chars,
                        const wchar_t *expected, size_t expected_chars,
                        const cr_string *names, size_t count,
                        uint32_t maximum, uint8_t **data, size_t *size) {
  nt_create_file_fn create = cr_nt_create_file();
  if (!create) return CR_IO;
  HANDLE root_handle =
      CreateFileW(root, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                  CR_SHARE_ALL, NULL, OPEN_EXISTING,
                  FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                  NULL);
  if (root_handle == INVALID_HANDLE_VALUE) return CR_ROOT_UNAVAILABLE;
  HANDLE current = root_handle;
  cr_state state = CR_IO;
  cr_kind kind = cr_inspect(root_handle);
  cr_name name = CR_UNNAMED;
  if (kind != CR_DIRECTORY) {
    // The resolved root is a real directory; anything else replaced it.
    state = kind == CR_UNKNOWN ? CR_ROOT_UNAVAILABLE : CR_ROOT_CHANGED;
    goto done;
  }
  name = cr_handle_named(root_handle, root, root_chars, root_chars);
  if (name != CR_NAMED) {
    state = cr_root_failure(name);
    goto done;
  }
  for (size_t at = 0; at < count; at++) {
    bool last = at + 1 == count;
    HANDLE child = INVALID_HANDLE_VALUE;
    NTSTATUS status = cr_open_child(create, current, &names[at], last, &child);
    if (current != root_handle) CloseHandle(current);
    current = child;
    if (current == INVALID_HANDLE_VALUE) {
      state = status >= 0 ? CR_IO : cr_open_failure(status);
      goto checked;
    }
    kind = cr_inspect(current);
    if (kind == CR_REPARSE) {
      state = CR_UNSAFE;
      goto checked;
    }
    if (kind == CR_UNKNOWN || (!last && kind != CR_DIRECTORY)) {
      state = CR_IO;
      goto checked;
    }
    if (last && kind != CR_FILE) {
      state = CR_NOT_FILE;
      goto checked;
    }
  }
  name = cr_handle_named(current, expected, expected_chars, root_chars);
  // The file's final path holds the root's, so `present` needs no root check.
  if (name == CR_NAMED) {
    state = cr_read_all(current, maximum, data, size);
    goto done;
  }
  state = cr_name_failure(name);
  if (state == CR_ROOT_CHANGED) goto done;
checked:
  name = cr_handle_named(root_handle, root, root_chars, root_chars);
  if (name != CR_NAMED) state = cr_root_failure(name);
done:
  if (current != INVALID_HANDLE_VALUE && current != root_handle)
    CloseHandle(current);
  CloseHandle(root_handle);
  return state;
}

static bool cr_set_text(napi_env env, napi_value object, const char *key,
                        const char *value) {
  napi_value text;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &text) ==
             napi_ok &&
         napi_set_named_property(env, object, key, text) == napi_ok;
}

static napi_value cr_result(napi_env env, cr_state state, const uint8_t *data,
                            size_t size) {
  napi_value out, bytes;
  void *copy = NULL;
  if (napi_create_object(env, &out) != napi_ok) return NULL;
  switch (state) {
    case CR_PRESENT:
      if (!cr_set_text(env, out, "state", "present") ||
          napi_create_buffer_copy(env, size, data, &copy, &bytes) != napi_ok ||
          napi_set_named_property(env, out, "bytes", bytes) != napi_ok)
        return NULL;
      return out;
    case CR_ABSENT:
      return cr_set_text(env, out, "state", "absent") ? out : NULL;
    case CR_TOO_LARGE:
      return cr_set_text(env, out, "state", "too-large") ? out : NULL;
    case CR_ROOT_UNAVAILABLE:
      return cr_set_text(env, out, "state", "root-unavailable") ? out : NULL;
    case CR_ROOT_CHANGED:
      return cr_set_text(env, out, "state", "root-changed") ? out : NULL;
    default:
      return cr_set_text(env, out, "state", "unreadable") &&
                     cr_set_text(env, out, "reason",
                                 state == CR_UNSAFE     ? "unsafe-path"
                                 : state == CR_NOT_FILE ? "not-file"
                                                        : "io")
                 ? out
                 : NULL;
  }
}

napi_value confined_read_file(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  cr_string root = {NULL, 0};
  cr_string names[CR_MAX_COMPONENTS];
  size_t count = 0;
  bool array = false;
  uint32_t length = 0;
  double maximum = -1;
  wchar_t *expected = NULL;
  wchar_t *rooted = NULL;
  size_t root_chars = 0;
  size_t expected_chars = 0;
  uint8_t *data = NULL;
  size_t size = 0;
  cr_state state = CR_IO;
  napi_value result = NULL;
  memset(names, 0, sizeof names);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 3 || !cr_copy_string(env, argv[0], CR_MAX_ROOT_CHARS, &root) ||
      !cr_valid_root(&root) ||
      napi_is_array(env, argv[1], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[1], &length) != napi_ok ||
      length == 0 || length > CR_MAX_COMPONENTS ||
      napi_get_value_double(env, argv[2], &maximum) != napi_ok ||
      !(maximum >= 0) || maximum > CR_MAX_BYTES ||
      maximum != (double)(uint32_t)maximum)
    goto invalid;
  for (uint32_t at = 0; at < length; at++) {
    napi_value item;
    if (napi_get_element(env, argv[1], at, &item) != napi_ok ||
        !cr_copy_string(env, item, CR_MAX_NAME_CHARS, &names[at]))
      goto invalid;
    count = (size_t)at + 1;
    if (!cr_valid_name(&names[at])) goto invalid;
  }
  expected = cr_expected_path(&root, names, count, &root_chars,
                              &expected_chars);
  if (expected) rooted = calloc(root_chars + 1, sizeof *rooted);
  if (rooted) {
    wmemcpy(rooted, expected, root_chars);
    state = cr_read(rooted, root_chars, expected, expected_chars, names, count,
                    (uint32_t)maximum, &data, &size);
  }
  result = cr_result(env, state, data, size);
  goto cleanup;
invalid:
  napi_throw_error(env, "ERR_CONFINED_READ_ARGUMENT",
                   "Confined read request is invalid.");
cleanup:
  free(data);
  free(rooted);
  free(expected);
  free(root.text);
  for (size_t at = 0; at < count; at++) free(names[at].text);
  return result;
}
