#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <windows.h>

#include <stdbool.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifdef _MSC_VER
#pragma comment(lib, "advapi32.lib")
#endif

#define PMD_PROTOCOL_VERSION 3U
#define PMD_MAX_ARGUMENTS 4096U
#define PMD_MAX_ARGUMENT_BYTES (1024U * 1024U)
#define PMD_MAX_ARGUMENTS_TOTAL_BYTES (8U * 1024U * 1024U)
#define PMD_MAX_CWD_BYTES (32U * 1024U)
#define PMD_MAX_RESPONSE_BYTES (64U * 1024U * 1024U)
#define PMD_LAUNCH_TIMEOUT_MILLISECONDS 10000ULL

#ifndef PMD_CLI_IDENTITY_W
#define PMD_CLI_IDENTITY_W L"pulse-md"
#endif

#ifndef PMD_COMMAND_NAME
#define PMD_COMMAND_NAME "pmd"
#endif

#define PMD_ERROR_PREFIX PMD_COMMAND_NAME ":"

#ifndef PMD_APP_EXECUTABLE_NAME_W
#define PMD_APP_EXECUTABLE_NAME_W L"Pulse MD.exe"
#endif

static const unsigned char protocol_magic[8] = {'P', 'M', 'D', 'C',
                                                 'L', 'I', '3', '\0'};
static volatile LONG interrupted = 0;
static PVOID volatile active_pipe = INVALID_HANDLE_VALUE;

enum connection_result {
  CONNECTION_READY = 1,
  CONNECTION_ABSENT = 0,
  CONNECTION_BUSY = -1,
  CONNECTION_FATAL = -2,
};

struct encoded_request {
  char **arguments;
  int argument_count;
  char *cwd;
  size_t cwd_length;
};

static HANDLE standard_handle(DWORD identifier) {
  HANDLE handle = GetStdHandle(identifier);
  return handle == NULL ? INVALID_HANDLE_VALUE : handle;
}

static int write_handle_all(HANDLE handle, const void *data, size_t length) {
  const unsigned char *cursor = (const unsigned char *)data;
  while (length > 0) {
    DWORD chunk = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
    DWORD written = 0;
    if (!WriteFile(handle, cursor, chunk, &written, NULL) || written == 0) {
      if (written == 0 && GetLastError() == ERROR_SUCCESS) {
        SetLastError(ERROR_WRITE_FAULT);
      }
      return -1;
    }
    cursor += written;
    length -= written;
  }
  return 0;
}

static int write_console_all(HANDLE handle, const wchar_t *text,
                             size_t length) {
  const wchar_t *cursor = text;
  while (length > 0) {
    DWORD chunk = length > 32767U ? 32767U : (DWORD)length;
    if ((size_t)chunk < length && chunk > 0 &&
        cursor[chunk - 1U] >= 0xd800 && cursor[chunk - 1U] <= 0xdbff) {
      chunk--;
    }
    DWORD written = 0;
    if (!WriteConsoleW(handle, cursor, chunk, &written, NULL) || written == 0) {
      return -1;
    }
    cursor += written;
    length -= written;
  }
  return 0;
}

static int write_utf8_output(HANDLE handle, const unsigned char *bytes,
                             size_t length) {
  if (length == 0) {
    return 0;
  }

  DWORD console_mode = 0;
  if (!GetConsoleMode(handle, &console_mode)) {
    return write_handle_all(handle, bytes, length);
  }
  if (length > INT_MAX) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return -1;
  }

  int wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        (const char *)bytes, (int)length, NULL,
                                        0);
  if (wide_length <= 0) {
    return -1;
  }
  wchar_t *wide = (wchar_t *)HeapAlloc(
      GetProcessHeap(), 0, (size_t)wide_length * sizeof(wchar_t));
  if (wide == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return -1;
  }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes,
                          (int)length, wide, wide_length) != wide_length) {
    HeapFree(GetProcessHeap(), 0, wide);
    return -1;
  }
  int result = write_console_all(handle, wide, (size_t)wide_length);
  HeapFree(GetProcessHeap(), 0, wide);
  return result;
}

static void report_error(const char *message) {
  HANDLE handle = standard_handle(STD_ERROR_HANDLE);
  if (handle != INVALID_HANDLE_VALUE) {
    (void)write_handle_all(handle, message, strlen(message));
  }
}

static void report_windows_error(const char *context, DWORD error_code) {
  char message[256];
  int length = _snprintf_s(message, sizeof(message), _TRUNCATE,
                           PMD_ERROR_PREFIX " %s (Windows error %lu)\n", context,
                           (unsigned long)error_code);
  if (length > 0) {
    report_error(message);
  } else {
    report_error(PMD_ERROR_PREFIX " a Windows operation failed\n");
  }
}

static BOOL WINAPI handle_console_control(DWORD control_type) {
  if (control_type != CTRL_C_EVENT && control_type != CTRL_BREAK_EVENT) {
    return FALSE;
  }

  InterlockedExchange(&interrupted, 1);
  HANDLE pipe = (HANDLE)InterlockedExchangePointer(
      &active_pipe, (PVOID)INVALID_HANDLE_VALUE);
  if (pipe != INVALID_HANDLE_VALUE) {
    const unsigned char cancellation = 0;
    DWORD written = 0;
    (void)WriteFile(pipe, &cancellation, sizeof(cancellation), &written, NULL);
    CloseHandle(pipe);
  }
  return TRUE;
}

static void set_active_pipe(HANDLE pipe) {
  (void)InterlockedExchangePointer(&active_pipe, pipe);
}

static void close_active_pipe(void) {
  HANDLE pipe = (HANDLE)InterlockedExchangePointer(
      &active_pipe, (PVOID)INVALID_HANDLE_VALUE);
  if (pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(pipe);
  }
}

static bool valid_utf8(const unsigned char *bytes, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = bytes[index++];
    if (first <= 0x7fU) {
      continue;
    }

    uint32_t codepoint = 0;
    size_t continuation_count = 0;
    uint32_t minimum = 0;
    if (first >= 0xc2U && first <= 0xdfU) {
      codepoint = first & 0x1fU;
      continuation_count = 1;
      minimum = 0x80U;
    } else if (first >= 0xe0U && first <= 0xefU) {
      codepoint = first & 0x0fU;
      continuation_count = 2;
      minimum = 0x800U;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      codepoint = first & 0x07U;
      continuation_count = 3;
      minimum = 0x10000U;
    } else {
      return false;
    }

    if (continuation_count > length - index) {
      return false;
    }
    for (size_t offset = 0; offset < continuation_count; offset++) {
      unsigned char next = bytes[index++];
      if ((next & 0xc0U) != 0x80U) {
        return false;
      }
      codepoint = (codepoint << 6U) | (next & 0x3fU);
    }

    if (codepoint < minimum || codepoint > 0x10ffffU ||
        (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
      return false;
    }
  }
  return true;
}

static char *wide_to_utf8(const wchar_t *wide, size_t *length_out) {
  int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1,
                                     NULL, 0, NULL, NULL);
  if (required <= 0) {
    return NULL;
  }
  char *utf8 = (char *)malloc((size_t)required);
  if (utf8 == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1, utf8,
                          required, NULL, NULL) != required) {
    free(utf8);
    return NULL;
  }
  *length_out = (size_t)required - 1U;
  return utf8;
}

static wchar_t *current_directory(void) {
  DWORD capacity = GetCurrentDirectoryW(0, NULL);
  if (capacity == 0) {
    return NULL;
  }
  wchar_t *directory =
      (wchar_t *)malloc((size_t)capacity * sizeof(wchar_t));
  if (directory == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  DWORD length = GetCurrentDirectoryW(capacity, directory);
  if (length == 0 || length >= capacity) {
    free(directory);
    return NULL;
  }
  return directory;
}

static void free_encoded_request(struct encoded_request *request) {
  if (request->arguments != NULL) {
    for (int index = 0; index < request->argument_count; index++) {
      free(request->arguments[index]);
    }
  }
  free(request->arguments);
  free(request->cwd);
  memset(request, 0, sizeof(*request));
}

static int encode_request(int argument_count, wchar_t *const arguments[],
                          struct encoded_request *request) {
  memset(request, 0, sizeof(*request));
  if (argument_count < 0 || (uint32_t)argument_count > PMD_MAX_ARGUMENTS) {
    report_error(PMD_ERROR_PREFIX " too many command-line arguments\n");
    return -1;
  }

  wchar_t *wide_cwd = current_directory();
  if (wide_cwd == NULL) {
    report_windows_error("cannot read the working directory", GetLastError());
    return -1;
  }
  request->cwd = wide_to_utf8(wide_cwd, &request->cwd_length);
  free(wide_cwd);
  if (request->cwd == NULL || request->cwd_length > PMD_MAX_CWD_BYTES) {
    report_error(PMD_ERROR_PREFIX " the working directory is not valid UTF-8\n");
    free_encoded_request(request);
    return -1;
  }

  request->argument_count = argument_count;
  if (argument_count > 0) {
    request->arguments =
        (char **)calloc((size_t)argument_count, sizeof(char *));
    if (request->arguments == NULL) {
      report_error(PMD_ERROR_PREFIX " out of memory while reading command-line arguments\n");
      free_encoded_request(request);
      return -1;
    }
  }

  size_t total_length = 0;
  for (int index = 0; index < argument_count; index++) {
    size_t length = 0;
    request->arguments[index] = wide_to_utf8(arguments[index], &length);
    if (request->arguments[index] == NULL) {
      report_error(PMD_ERROR_PREFIX " command-line arguments must be valid UTF-8\n");
      free_encoded_request(request);
      return -1;
    }
    if (length > PMD_MAX_ARGUMENT_BYTES ||
        total_length > PMD_MAX_ARGUMENTS_TOTAL_BYTES - length) {
      report_error(PMD_ERROR_PREFIX " command-line arguments are too large\n");
      free_encoded_request(request);
      return -1;
    }
    total_length += length;
  }
  return 0;
}

static wchar_t *read_environment_variable(const wchar_t *name) {
  SetLastError(ERROR_SUCCESS);
  DWORD required = GetEnvironmentVariableW(name, NULL, 0);
  if (required == 0) {
    if (GetLastError() == ERROR_SUCCESS) {
      wchar_t *empty = (wchar_t *)malloc(sizeof(wchar_t));
      if (empty == NULL) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return NULL;
      }
      empty[0] = L'\0';
      return empty;
    }
    return NULL;
  }
  wchar_t *value = (wchar_t *)malloc((size_t)required * sizeof(wchar_t));
  if (value == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  SetLastError(ERROR_SUCCESS);
  DWORD length = GetEnvironmentVariableW(name, value, required);
  if (length >= required ||
      (length == 0 && GetLastError() != ERROR_SUCCESS)) {
    free(value);
    return NULL;
  }
  return value;
}

static wchar_t *cli_endpoint(void) {
  static const wchar_t local_pipe_prefix[] = L"\\\\.\\pipe\\";
  static const wchar_t prefix[] =
      L"\\\\.\\pipe\\" PMD_CLI_IDENTITY_W L"-";
  static const wchar_t suffix[] = L"-cli-v3";

  wchar_t *configured_endpoint =
      read_environment_variable(L"PMD_CLI_ENDPOINT");
  if (configured_endpoint != NULL) {
    if (configured_endpoint[0] == L'\0') {
      report_error(PMD_ERROR_PREFIX " PMD_CLI_ENDPOINT cannot be empty\n");
      free(configured_endpoint);
      SetLastError(ERROR_INVALID_DATA);
      return NULL;
    }
    if (wcsncmp(configured_endpoint, local_pipe_prefix,
                sizeof(local_pipe_prefix) / sizeof(wchar_t) - 1U) != 0) {
      report_error(
          PMD_ERROR_PREFIX " PMD_CLI_ENDPOINT must name a local Windows pipe\n");
      free(configured_endpoint);
      SetLastError(ERROR_INVALID_NAME);
      return NULL;
    }
    return configured_endpoint;
  }

  wchar_t *identity = read_environment_variable(L"APPDATA");
  if (identity == NULL || identity[0] == L'\0') {
    free(identity);
    identity = read_environment_variable(L"USERPROFILE");
  }
  if (identity == NULL || identity[0] == L'\0') {
    free(identity);
    wchar_t *domain = read_environment_variable(L"USERDOMAIN");
    wchar_t *username = read_environment_variable(L"USERNAME");
    const wchar_t *safe_domain = domain == NULL ? L"" : domain;
    const wchar_t *safe_username = username == NULL ? L"" : username;
    size_t domain_length = wcslen(safe_domain);
    size_t username_length = wcslen(safe_username);
    size_t separator_length = domain_length > 0 && username_length > 0 ? 1U : 0U;
    identity = (wchar_t *)malloc(
        (domain_length + separator_length + username_length + 1U) *
        sizeof(wchar_t));
    if (identity != NULL) {
      memcpy(identity, safe_domain, domain_length * sizeof(wchar_t));
      if (separator_length != 0) identity[domain_length] = L'\\';
      memcpy(identity + domain_length + separator_length, safe_username,
             (username_length + 1U) * sizeof(wchar_t));
    }
    free(domain);
    free(username);
  }
  if (identity == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (identity[0] == L'\0') {
    free(identity);
    identity = _wcsdup(L"unknown-user");
    if (identity == NULL) {
      SetLastError(ERROR_NOT_ENOUGH_MEMORY);
      return NULL;
    }
  }

  uint64_t identity_hash = UINT64_C(0xcbf29ce484222325);
  for (size_t index = 0; identity[index] != L'\0'; index++) {
    uint16_t code_unit = (uint16_t)identity[index];
    identity_hash ^= (unsigned char)(code_unit & 0xffU);
    identity_hash *= UINT64_C(0x100000001b3);
    identity_hash ^= (unsigned char)(code_unit >> 8U);
    identity_hash *= UINT64_C(0x100000001b3);
  }
  free(identity);

  static const wchar_t hexadecimal[] = L"0123456789abcdef";
  wchar_t encoded_identity[17];
  for (size_t index = 0; index < 16U; index++) {
    unsigned int shift = (unsigned int)((15U - index) * 4U);
    encoded_identity[index] = hexadecimal[(identity_hash >> shift) & 0xfU];
  }
  encoded_identity[16] = L'\0';

  size_t endpoint_length = (sizeof(prefix) / sizeof(wchar_t) - 1U) + 16U +
                           (sizeof(suffix) / sizeof(wchar_t) - 1U);
  wchar_t *endpoint =
      (wchar_t *)malloc((endpoint_length + 1U) * sizeof(wchar_t));
  if (endpoint == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }

  size_t offset = 0;
  memcpy(endpoint + offset, prefix, sizeof(prefix) - sizeof(wchar_t));
  offset += sizeof(prefix) / sizeof(wchar_t) - 1U;
  memcpy(endpoint + offset, encoded_identity, 16U * sizeof(wchar_t));
  offset += 16U;
  memcpy(endpoint + offset, suffix, sizeof(suffix));
  return endpoint;
}

static void *token_user(HANDLE process, DWORD *length_out) {
  HANDLE token = NULL;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
    return NULL;
  }

  DWORD required = 0;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &required);
  if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    CloseHandle(token);
    return NULL;
  }
  void *buffer = malloc(required);
  if (buffer == NULL) {
    CloseHandle(token);
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (!GetTokenInformation(token, TokenUser, buffer, required, &required)) {
    free(buffer);
    CloseHandle(token);
    return NULL;
  }
  CloseHandle(token);
  *length_out = required;
  return buffer;
}

static int validate_pipe_server(HANDLE pipe) {
  ULONG server_process_id = 0;
  if (!GetNamedPipeServerProcessId(pipe, &server_process_id) ||
      server_process_id == 0) {
    report_windows_error("cannot identify the CLI pipe server",
                         GetLastError());
    return -1;
  }

  HANDLE server_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                      server_process_id);
  if (server_process == NULL) {
    report_windows_error("cannot inspect the CLI pipe server",
                         GetLastError());
    return -1;
  }

  DWORD current_length = 0;
  DWORD server_length = 0;
  void *current_user = token_user(GetCurrentProcess(), &current_length);
  void *server_user = token_user(server_process, &server_length);
  CloseHandle(server_process);
  (void)current_length;
  (void)server_length;
  if (current_user == NULL || server_user == NULL) {
    DWORD error_code = GetLastError();
    free(current_user);
    free(server_user);
    report_windows_error("cannot verify the CLI pipe server user", error_code);
    return -1;
  }

  PSID current_sid = ((TOKEN_USER *)current_user)->User.Sid;
  PSID server_sid = ((TOKEN_USER *)server_user)->User.Sid;
  bool trusted = IsValidSid(current_sid) && IsValidSid(server_sid) &&
                 EqualSid(current_sid, server_sid);
  free(current_user);
  free(server_user);
  if (!trusted) {
    report_error(PMD_ERROR_PREFIX " refusing a CLI pipe owned by a different user\n");
    SetLastError(ERROR_ACCESS_DENIED);
    return -1;
  }
  return 0;
}

static enum connection_result connect_to_endpoint(const wchar_t *endpoint,
                                                   HANDLE *pipe_out) {
  HANDLE pipe = CreateFileW(endpoint, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (pipe == INVALID_HANDLE_VALUE) {
    DWORD error_code = GetLastError();
    if (error_code == ERROR_FILE_NOT_FOUND ||
        error_code == ERROR_PATH_NOT_FOUND) {
      return CONNECTION_ABSENT;
    }
    if (error_code == ERROR_PIPE_BUSY || error_code == ERROR_SEM_TIMEOUT) {
      return CONNECTION_BUSY;
    }
    if (InterlockedCompareExchange(&interrupted, 0, 0) == 0) {
      report_windows_error("cannot connect to the app's CLI pipe", error_code);
    }
    return CONNECTION_FATAL;
  }

  if (validate_pipe_server(pipe) != 0) {
    CloseHandle(pipe);
    return CONNECTION_FATAL;
  }
  *pipe_out = pipe;
  return CONNECTION_READY;
}

static wchar_t *module_path(void) {
  DWORD capacity = 512;
  for (;;) {
    wchar_t *path = (wchar_t *)malloc((size_t)capacity * sizeof(wchar_t));
    if (path == NULL) {
      SetLastError(ERROR_NOT_ENOUGH_MEMORY);
      return NULL;
    }
    SetLastError(ERROR_SUCCESS);
    DWORD length = GetModuleFileNameW(NULL, path, capacity);
    if (length == 0) {
      free(path);
      return NULL;
    }
    if (length < capacity - 1U ||
        (length < capacity && GetLastError() != ERROR_INSUFFICIENT_BUFFER)) {
      path[length] = L'\0';
      return path;
    }
    free(path);
    if (capacity > 32768U) {
      SetLastError(ERROR_FILENAME_EXCED_RANGE);
      return NULL;
    }
    capacity *= 2U;
  }
}

static bool remove_last_path_component(wchar_t *path) {
  size_t length = wcslen(path);
  while (length > 0 &&
         (path[length - 1U] == L'\\' || path[length - 1U] == L'/')) {
    path[--length] = L'\0';
  }
  while (length > 0 && path[length - 1U] != L'\\' &&
         path[length - 1U] != L'/') {
    length--;
  }
  if (length == 0 || (length == 3 && path[1] == L':')) {
    return false;
  }
  path[length - 1U] = L'\0';
  return true;
}

static wchar_t *absolute_path(const wchar_t *path) {
  DWORD required = GetFullPathNameW(path, 0, NULL, NULL);
  if (required == 0) {
    return NULL;
  }
  wchar_t *absolute =
      (wchar_t *)malloc((size_t)required * sizeof(wchar_t));
  if (absolute == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  DWORD length = GetFullPathNameW(path, required, absolute, NULL);
  if (length == 0 || length >= required) {
    free(absolute);
    return NULL;
  }
  return absolute;
}

static wchar_t *default_app_executable(void) {
  static const wchar_t suffix[] = L"\\" PMD_APP_EXECUTABLE_NAME_W;
  wchar_t *path = module_path();
  if (path == NULL) {
    return NULL;
  }
  for (int level = 0; level < 3; level++) {
    if (!remove_last_path_component(path)) {
      free(path);
      SetLastError(ERROR_FILE_NOT_FOUND);
      return NULL;
    }
  }

  size_t root_length = wcslen(path);
  size_t suffix_length = sizeof(suffix) / sizeof(wchar_t);
  if (root_length > SIZE_MAX / sizeof(wchar_t) - suffix_length) {
    free(path);
    SetLastError(ERROR_FILENAME_EXCED_RANGE);
    return NULL;
  }
  wchar_t *result = (wchar_t *)realloc(
      path, (root_length + suffix_length) * sizeof(wchar_t));
  if (result == NULL) {
    free(path);
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  memcpy(result + root_length, suffix, sizeof(suffix));
  return result;
}

static wchar_t *app_executable(void) {
  wchar_t *configured = read_environment_variable(L"PMD_APP_EXECUTABLE");
  if (configured == NULL || configured[0] == L'\0') {
    free(configured);
    return default_app_executable();
  }
  wchar_t *resolved = absolute_path(configured);
  free(configured);
  return resolved;
}

static int launch_app(const wchar_t *app_path) {
  static const wchar_t argument[] =
      L" --pmd-cli-server --disable-error-dialogs";
  size_t path_length = wcslen(app_path);
  size_t command_length = path_length +
                          (sizeof(argument) / sizeof(wchar_t) - 1U) + 2U;
  wchar_t *command =
      (wchar_t *)malloc((command_length + 1U) * sizeof(wchar_t));
  wchar_t *working_directory = _wcsdup(app_path);
  if (command == NULL || working_directory == NULL) {
    free(command);
    free(working_directory);
    report_error(PMD_ERROR_PREFIX " out of memory while preparing the app launch\n");
    return -1;
  }
  command[0] = L'\"';
  memcpy(command + 1U, app_path, path_length * sizeof(wchar_t));
  command[path_length + 1U] = L'\"';
  memcpy(command + path_length + 2U, argument, sizeof(argument));
  if (!remove_last_path_component(working_directory)) {
    free(command);
    free(working_directory);
    report_error(PMD_ERROR_PREFIX " cannot determine the app installation directory\n");
    return -1;
  }

  STARTUPINFOW startup_info;
  PROCESS_INFORMATION process_info;
  memset(&startup_info, 0, sizeof(startup_info));
  memset(&process_info, 0, sizeof(process_info));
  startup_info.cb = (DWORD)sizeof(startup_info);
  BOOL created = CreateProcessW(
      app_path, command, NULL, NULL, FALSE,
      DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
      NULL, working_directory, &startup_info, &process_info);
  DWORD error_code = GetLastError();
  free(command);
  free(working_directory);
  if (!created) {
    report_windows_error("cannot launch Pulse MD", error_code);
    return -1;
  }
  CloseHandle(process_info.hThread);
  CloseHandle(process_info.hProcess);
  return 0;
}

static bool request_uses_stdin(int argument_count,
                               wchar_t *const arguments[]) {
  if (argument_count > 0 &&
      (wcscmp(arguments[0], L"profile") == 0 ||
       wcscmp(arguments[0], L"scratch") == 0)) {
    return false;
  }
  for (int index = 0; index < argument_count; index++) {
    if (wcscmp(arguments[index], L"-") == 0) {
      return true;
    }
  }
  return false;
}

static bool standard_input_is_redirected(void) {
  HANDLE input = standard_handle(STD_INPUT_HANDLE);
  if (input == INVALID_HANDLE_VALUE) {
    return false;
  }
  DWORD console_mode = 0;
  return !GetConsoleMode(input, &console_mode);
}

static wchar_t *temporary_directory(void) {
  DWORD capacity = 512;
  for (;;) {
    wchar_t *directory =
        (wchar_t *)malloc((size_t)capacity * sizeof(wchar_t));
    if (directory == NULL) {
      SetLastError(ERROR_NOT_ENOUGH_MEMORY);
      return NULL;
    }
    DWORD length = GetTempPathW(capacity, directory);
    if (length == 0) {
      free(directory);
      return NULL;
    }
    if (length < capacity) {
      return directory;
    }
    free(directory);
    capacity = length + 1U;
    if (capacity > 32768U) {
      SetLastError(ERROR_FILENAME_EXCED_RANGE);
      return NULL;
    }
  }
}

static wchar_t *extended_path(const wchar_t *path) {
  static const wchar_t local_prefix[] = L"\\\\?\\";
  static const wchar_t unc_prefix[] = L"\\\\?\\UNC\\";
  if (wcsncmp(path, local_prefix,
              sizeof(local_prefix) / sizeof(wchar_t) - 1U) == 0) {
    return _wcsdup(path);
  }

  bool unc = path[0] == L'\\' && path[1] == L'\\';
  const wchar_t *prefix = unc ? unc_prefix : local_prefix;
  size_t prefix_length = wcslen(prefix);
  const wchar_t *remainder = unc ? path + 2 : path;
  size_t remainder_length = wcslen(remainder);
  wchar_t *result = (wchar_t *)malloc(
      (prefix_length + remainder_length + 1U) * sizeof(wchar_t));
  if (result == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  memcpy(result, prefix, prefix_length * sizeof(wchar_t));
  memcpy(result + prefix_length, remainder,
         (remainder_length + 1U) * sizeof(wchar_t));
  return result;
}

static HANDLE create_stdin_spool(void) {
  wchar_t *directory = temporary_directory();
  if (directory == NULL) {
    return INVALID_HANDLE_VALUE;
  }
  size_t directory_length = wcslen(directory);
  bool needs_separator = directory_length == 0 ||
                         (directory[directory_length - 1U] != L'\\' &&
                          directory[directory_length - 1U] != L'/');
  size_t candidate_capacity = directory_length + 96U;
  wchar_t *candidate = (wchar_t *)malloc(candidate_capacity * sizeof(wchar_t));
  if (candidate == NULL) {
    free(directory);
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return INVALID_HANDLE_VALUE;
  }

  HANDLE spool = INVALID_HANDLE_VALUE;
  for (unsigned int attempt = 0; attempt < 128U; attempt++) {
    int length = _snwprintf_s(
        candidate, candidate_capacity, _TRUNCATE,
        needs_separator ? L"%ls\\pmd-cli-%lu-%llu-%u.tmp"
                        : L"%lspmd-cli-%lu-%llu-%u.tmp",
        directory, (unsigned long)GetCurrentProcessId(),
        (unsigned long long)GetTickCount64(), attempt);
    if (length < 0) {
      SetLastError(ERROR_FILENAME_EXCED_RANGE);
      break;
    }
    wchar_t *open_path = extended_path(candidate);
    if (open_path == NULL) {
      break;
    }
    spool = CreateFileW(open_path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                        CREATE_NEW,
                        FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE |
                            FILE_FLAG_SEQUENTIAL_SCAN,
                        NULL);
    DWORD error_code = GetLastError();
    free(open_path);
    if (spool != INVALID_HANDLE_VALUE) {
      break;
    }
    if (error_code != ERROR_FILE_EXISTS && error_code != ERROR_ALREADY_EXISTS) {
      SetLastError(error_code);
      break;
    }
  }
  free(candidate);
  free(directory);
  return spool;
}

static int spool_standard_input(HANDLE *spool_out, uint64_t *length_out) {
  HANDLE spool = create_stdin_spool();
  if (spool == INVALID_HANDLE_VALUE) {
    report_windows_error("cannot create a temporary stdin file",
                         GetLastError());
    return -1;
  }

  HANDLE input = standard_handle(STD_INPUT_HANDLE);
  unsigned char buffer[64U * 1024U];
  uint64_t total_length = 0;
  for (;;) {
    DWORD received = 0;
    if (!ReadFile(input, buffer, (DWORD)sizeof(buffer), &received, NULL)) {
      DWORD error_code = GetLastError();
      if (error_code == ERROR_BROKEN_PIPE) {
        break;
      }
      CloseHandle(spool);
      if (InterlockedCompareExchange(&interrupted, 0, 0) == 0) {
        report_windows_error("cannot read standard input", error_code);
      }
      return -1;
    }
    if (received == 0) {
      break;
    }
    if (UINT64_MAX - total_length < received ||
        write_handle_all(spool, buffer, received) != 0) {
      DWORD error_code = GetLastError();
      CloseHandle(spool);
      report_windows_error("cannot spool standard input", error_code);
      return -1;
    }
    total_length += received;
    if (InterlockedCompareExchange(&interrupted, 0, 0) != 0) {
      CloseHandle(spool);
      return -1;
    }
  }

  LARGE_INTEGER beginning;
  beginning.QuadPart = 0;
  if (!SetFilePointerEx(spool, beginning, NULL, FILE_BEGIN)) {
    DWORD error_code = GetLastError();
    CloseHandle(spool);
    report_windows_error("cannot rewind standard input", error_code);
    return -1;
  }
  *spool_out = spool;
  *length_out = total_length;
  return 0;
}

static int send_u32(HANDLE pipe, uint32_t value) {
  unsigned char encoded[4] = {(unsigned char)(value >> 24U),
                              (unsigned char)(value >> 16U),
                              (unsigned char)(value >> 8U),
                              (unsigned char)value};
  return write_handle_all(pipe, encoded, sizeof(encoded));
}

static int send_u64(HANDLE pipe, uint64_t value) {
  unsigned char encoded[8] = {
      (unsigned char)(value >> 56U), (unsigned char)(value >> 48U),
      (unsigned char)(value >> 40U), (unsigned char)(value >> 32U),
      (unsigned char)(value >> 24U), (unsigned char)(value >> 16U),
      (unsigned char)(value >> 8U),  (unsigned char)value};
  return write_handle_all(pipe, encoded, sizeof(encoded));
}

static int send_request(HANDLE pipe, const struct encoded_request *request,
                        HANDLE stdin_spool, uint64_t stdin_length) {
  bool stdin_present = stdin_spool != INVALID_HANDLE_VALUE;
  if (write_handle_all(pipe, protocol_magic, sizeof(protocol_magic)) != 0 ||
      send_u32(pipe, PMD_PROTOCOL_VERSION) != 0 ||
      send_u32(pipe, (uint32_t)request->argument_count) != 0 ||
      send_u32(pipe, (uint32_t)request->cwd_length) != 0) {
    return -1;
  }
  unsigned char stdin_flag = stdin_present ? 1U : 0U;
  unsigned char active_window_flag = 0U;
  if (write_handle_all(pipe, &stdin_flag, sizeof(stdin_flag)) != 0 ||
      send_u64(pipe, stdin_present ? stdin_length : 0U) != 0 ||
      write_handle_all(pipe, &active_window_flag,
                       sizeof(active_window_flag)) != 0 ||
      send_u32(pipe, 0U) != 0 || send_u32(pipe, 0U) != 0 ||
      send_u32(pipe, 0U) != 0 || send_u32(pipe, 0U) != 0 ||
      write_handle_all(pipe, request->cwd, request->cwd_length) != 0) {
    return -1;
  }
  for (int index = 0; index < request->argument_count; index++) {
    size_t length = strlen(request->arguments[index]);
    if (send_u32(pipe, (uint32_t)length) != 0 ||
        write_handle_all(pipe, request->arguments[index], length) != 0) {
      return -1;
    }
  }

  if (stdin_present) {
    unsigned char buffer[64U * 1024U];
    uint64_t remaining = stdin_length;
    while (remaining > 0) {
      DWORD requested = remaining > sizeof(buffer) ? (DWORD)sizeof(buffer)
                                                   : (DWORD)remaining;
      DWORD received = 0;
      if (!ReadFile(stdin_spool, buffer, requested, &received, NULL) ||
          received == 0 || write_handle_all(pipe, buffer, received) != 0) {
        return -1;
      }
      remaining -= received;
    }
  }
  return 0;
}

static int read_exact(HANDLE pipe, void *data, size_t length) {
  unsigned char *cursor = (unsigned char *)data;
  while (length > 0) {
    DWORD chunk = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
    DWORD received = 0;
    if (!ReadFile(pipe, cursor, chunk, &received, NULL) || received == 0) {
      return -1;
    }
    cursor += received;
    length -= received;
  }
  return 0;
}

static int receive_response(HANDLE pipe) {
  bool waiting = false;
  bool streaming_output = false;
  for (;;) {
    unsigned char header[6];
    if (read_exact(pipe, header, sizeof(header)) != 0) {
      if (InterlockedCompareExchange(&interrupted, 0, 0) == 0) {
        report_error(PMD_ERROR_PREFIX " the app closed the CLI connection unexpectedly\n");
      }
      return -1;
    }

    uint32_t payload_length = ((uint32_t)header[2] << 24U) |
                              ((uint32_t)header[3] << 16U) |
                              ((uint32_t)header[4] << 8U) |
                              (uint32_t)header[5];
    if (payload_length > PMD_MAX_RESPONSE_BYTES) {
      report_error(PMD_ERROR_PREFIX " the app returned an oversized CLI response\n");
      return -1;
    }

    unsigned char *payload = NULL;
    if (payload_length > 0) {
      payload = (unsigned char *)malloc(payload_length);
      if (payload == NULL) {
        report_error(PMD_ERROR_PREFIX " out of memory while reading the CLI response\n");
        return -1;
      }
      if (read_exact(pipe, payload, payload_length) != 0) {
        free(payload);
        if (InterlockedCompareExchange(&interrupted, 0, 0) == 0) {
          report_error(
              PMD_ERROR_PREFIX " the app closed the CLI connection unexpectedly\n");
        }
        return -1;
      }
      if (!valid_utf8(payload, payload_length)) {
        free(payload);
        report_error(PMD_ERROR_PREFIX " the app returned a non-UTF-8 CLI response\n");
        return -1;
      }
    }

    unsigned char kind = header[0];
    if ((waiting && kind != 'd') || (!waiting && kind == 'd') ||
        (streaming_output && kind != 'c' && kind != 'o' && kind != 'e') ||
        (kind != 'o' && kind != 'c' && kind != 'e' && kind != 'a' &&
         kind != 'w' && kind != 'd')) {
      free(payload);
      report_error(PMD_ERROR_PREFIX " the app returned an invalid CLI response sequence\n");
      return -1;
    }

    HANDLE output =
        standard_handle(kind == 'e' ? STD_ERROR_HANDLE : STD_OUTPUT_HANDLE);
    if (payload_length > 0 &&
        (output == INVALID_HANDLE_VALUE ||
         write_utf8_output(output, payload, payload_length) != 0)) {
      free(payload);
      report_error(PMD_ERROR_PREFIX " cannot write the app's CLI response\n");
      return -1;
    }
    free(payload);
    if (kind == 'w') {
      waiting = true;
      continue;
    }
    if (kind == 'c') {
      streaming_output = true;
      continue;
    }
    return header[1];
  }
}

int wmain(int argc, wchar_t *argv[]) {
  if (!SetConsoleCtrlHandler(handle_console_control, TRUE)) {
    report_windows_error("cannot install the console control handler",
                         GetLastError());
    return 1;
  }

  struct encoded_request request;
  if (encode_request(argc - 1, argv + 1, &request) != 0) {
    return 1;
  }

  HANDLE stdin_spool = INVALID_HANDLE_VALUE;
  uint64_t stdin_length = 0;
  bool stdin_present = request_uses_stdin(argc - 1, argv + 1) &&
                       standard_input_is_redirected();
  if (stdin_present &&
      spool_standard_input(&stdin_spool, &stdin_length) != 0) {
    free_encoded_request(&request);
    return InterlockedCompareExchange(&interrupted, 0, 0) != 0 ? 130 : 1;
  }

  wchar_t *endpoint = cli_endpoint();
  if (endpoint == NULL) {
    DWORD endpoint_error = GetLastError();
    if (endpoint_error != ERROR_INVALID_DATA &&
        endpoint_error != ERROR_INVALID_NAME) {
      report_windows_error("cannot determine the CLI pipe name",
                           endpoint_error);
    }
    if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
    free_encoded_request(&request);
    return 1;
  }

  HANDLE pipe = INVALID_HANDLE_VALUE;
  enum connection_result connection = connect_to_endpoint(endpoint, &pipe);
  if (connection == CONNECTION_FATAL) {
    free(endpoint);
    if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
    free_encoded_request(&request);
    return InterlockedCompareExchange(&interrupted, 0, 0) != 0 ? 130 : 1;
  }

  if (connection == CONNECTION_ABSENT) {
    wchar_t *app_path = app_executable();
    DWORD attributes = app_path == NULL ? INVALID_FILE_ATTRIBUTES
                                        : GetFileAttributesW(app_path);
    if (app_path == NULL || attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      report_error(
          PMD_ERROR_PREFIX " cannot locate the Pulse MD executable\n");
      free(app_path);
      free(endpoint);
      if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
      free_encoded_request(&request);
      return 1;
    }
    if (launch_app(app_path) != 0) {
      free(app_path);
      free(endpoint);
      if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
      free_encoded_request(&request);
      return InterlockedCompareExchange(&interrupted, 0, 0) != 0 ? 130 : 1;
    }
    free(app_path);
  }

  ULONGLONG start = GetTickCount64();
  ULONGLONG deadline = start + PMD_LAUNCH_TIMEOUT_MILLISECONDS;
  while (connection != CONNECTION_READY && connection != CONNECTION_FATAL &&
         InterlockedCompareExchange(&interrupted, 0, 0) == 0) {
    Sleep(25);
    connection = connect_to_endpoint(endpoint, &pipe);
    if (GetTickCount64() >= deadline) {
      break;
    }
  }
  free(endpoint);

  if (connection != CONNECTION_READY) {
    if (InterlockedCompareExchange(&interrupted, 0, 0) == 0 &&
        connection != CONNECTION_FATAL) {
      report_error(
          PMD_ERROR_PREFIX " could not connect to the app's CLI service within 10 seconds\n");
    }
    if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
    free_encoded_request(&request);
    return InterlockedCompareExchange(&interrupted, 0, 0) != 0 ? 130 : 1;
  }

  set_active_pipe(pipe);
  if (InterlockedCompareExchange(&interrupted, 0, 0) != 0) {
    close_active_pipe();
    if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
    free_encoded_request(&request);
    return 130;
  }
  if (send_request(pipe, &request, stdin_spool, stdin_length) != 0) {
    if (InterlockedCompareExchange(&interrupted, 0, 0) == 0) {
      report_windows_error("cannot send the CLI request", GetLastError());
    }
    close_active_pipe();
    if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
    free_encoded_request(&request);
    return InterlockedCompareExchange(&interrupted, 0, 0) != 0 ? 130 : 1;
  }
  if (stdin_spool != INVALID_HANDLE_VALUE) CloseHandle(stdin_spool);
  free_encoded_request(&request);

  int exit_code = receive_response(pipe);
  close_active_pipe();
  if (InterlockedCompareExchange(&interrupted, 0, 0) != 0) {
    return 130;
  }
  return exit_code < 0 ? 1 : exit_code;
}
