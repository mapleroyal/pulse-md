#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <mach-o/dyld.h>
#endif

#define PMD_PROTOCOL_VERSION 3U
#define PMD_MAX_ARGUMENTS 4096U
#define PMD_MAX_ARGUMENT_BYTES (1024U * 1024U)
#define PMD_MAX_ARGUMENTS_TOTAL_BYTES (8U * 1024U * 1024U)
#define PMD_MAX_CWD_BYTES (32U * 1024U)
#define PMD_MAX_RESPONSE_BYTES (64U * 1024U * 1024U)
#define PMD_LAUNCH_TIMEOUT_MILLISECONDS 10000

#ifndef PMD_CLI_IDENTITY
#define PMD_CLI_IDENTITY "pulse-md"
#endif

#ifndef PMD_COMMAND_NAME
#define PMD_COMMAND_NAME "pmd"
#endif

#define PMD_ERROR_PREFIX PMD_COMMAND_NAME ":"

#ifndef PMD_APP_EXECUTABLE_NAME
#ifdef __APPLE__
#define PMD_APP_EXECUTABLE_NAME "Pulse MD"
#elif defined(__linux__)
#define PMD_APP_EXECUTABLE_NAME "pulse-md"
#endif
#endif

static const unsigned char protocol_magic[8] = {'P', 'M', 'D', 'C',
                                                'L', 'I', '3', '\0'};
static volatile sig_atomic_t interrupted = 0;
static volatile sig_atomic_t active_socket = -1;

enum connection_result {
  CONNECTION_READY = 1,
  CONNECTION_RETRY = 0,
  CONNECTION_FATAL = -1,
};

struct active_window_bounds {
  bool valid;
  int32_t x;
  int32_t y;
  int32_t width;
  int32_t height;
};

#ifdef __APPLE__
static bool store_active_window_bounds(CGRect bounds,
                                       struct active_window_bounds *result) {
  if (!isfinite(bounds.origin.x) || !isfinite(bounds.origin.y) ||
      !isfinite(bounds.size.width) || !isfinite(bounds.size.height) ||
      bounds.size.width <= 0 || bounds.size.height <= 0 ||
      bounds.origin.x < INT32_MIN || bounds.origin.x > INT32_MAX ||
      bounds.origin.y < INT32_MIN || bounds.origin.y > INT32_MAX ||
      bounds.size.width > INT32_MAX || bounds.size.height > INT32_MAX) {
    return false;
  }

  result->valid = true;
  result->x = (int32_t)bounds.origin.x;
  result->y = (int32_t)bounds.origin.y;
  result->width = (int32_t)bounds.size.width;
  result->height = (int32_t)bounds.size.height;
  return true;
}

static bool capture_focused_window_bounds(
    pid_t process_id, struct active_window_bounds *result) {
  AXUIElementRef application = AXUIElementCreateApplication(process_id);
  if (application == NULL) {
    return false;
  }

  CFTypeRef focused_window_value = NULL;
  AXError focused_window_error = AXUIElementCopyAttributeValue(
      application, kAXFocusedWindowAttribute, &focused_window_value);
  CFRelease(application);
  if (focused_window_error != kAXErrorSuccess ||
      focused_window_value == NULL ||
      CFGetTypeID(focused_window_value) != AXUIElementGetTypeID()) {
    if (focused_window_value != NULL) {
      CFRelease(focused_window_value);
    }
    return false;
  }

  AXUIElementRef focused_window = (AXUIElementRef)focused_window_value;
  CFTypeRef position_value = NULL;
  CFTypeRef size_value = NULL;
  AXError position_error = AXUIElementCopyAttributeValue(
      focused_window, kAXPositionAttribute, &position_value);
  AXError size_error = AXUIElementCopyAttributeValue(
      focused_window, kAXSizeAttribute, &size_value);
  CFRelease(focused_window_value);

  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool captured =
      position_error == kAXErrorSuccess && size_error == kAXErrorSuccess &&
      position_value != NULL && size_value != NULL &&
      CFGetTypeID(position_value) == AXValueGetTypeID() &&
      CFGetTypeID(size_value) == AXValueGetTypeID() &&
      AXValueGetType((AXValueRef)position_value) == kAXValueCGPointType &&
      AXValueGetType((AXValueRef)size_value) == kAXValueCGSizeType &&
      AXValueGetValue((AXValueRef)position_value, kAXValueCGPointType,
                      &position) &&
      AXValueGetValue((AXValueRef)size_value, kAXValueCGSizeType, &size) &&
      store_active_window_bounds(
          CGRectMake(position.x, position.y, size.width, size.height), result);

  if (position_value != NULL) {
    CFRelease(position_value);
  }
  if (size_value != NULL) {
    CFRelease(size_value);
  }
  return captured;
}
#endif

static struct active_window_bounds capture_active_window_bounds(void) {
  struct active_window_bounds result = {0};
#ifdef __APPLE__
  pid_t frontmost_process_id = 0;
  @autoreleasepool {
    NSRunningApplication *frontmost_application =
        [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (frontmost_application != nil) {
      frontmost_process_id = [frontmost_application processIdentifier];
    }
  }
  if (frontmost_process_id <= 0) {
    return result;
  }

  // WindowServer stacking order can disagree with the application's actual
  // key window when one application has windows on separate-display Spaces.
  // Query the focused window for the already-known frontmost process first;
  // this attribute is available without prompting for Accessibility access.
  if (capture_focused_window_bounds(frontmost_process_id, &result)) {
    return result;
  }

  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (windows == NULL) {
    return result;
  }

  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef window =
        (CFDictionaryRef)CFArrayGetValueAtIndex(windows, index);
    CFNumberRef owner_process_value =
        (CFNumberRef)CFDictionaryGetValue(window, kCGWindowOwnerPID);
    int32_t owner_process_id = 0;
    if (owner_process_value == NULL ||
        !CFNumberGetValue(owner_process_value, kCFNumberSInt32Type,
                          &owner_process_id) ||
        owner_process_id != frontmost_process_id) {
      continue;
    }
    CFNumberRef layer_value =
        (CFNumberRef)CFDictionaryGetValue(window, kCGWindowLayer);
    int32_t layer = 0;
    if (layer_value == NULL ||
        !CFNumberGetValue(layer_value, kCFNumberSInt32Type, &layer) ||
        layer != 0) {
      continue;
    }
    CFNumberRef alpha_value =
        (CFNumberRef)CFDictionaryGetValue(window, kCGWindowAlpha);
    double alpha = 0;
    if (alpha_value == NULL ||
        !CFNumberGetValue(alpha_value, kCFNumberDoubleType, &alpha) ||
        alpha <= 0) {
      continue;
    }

    CFDictionaryRef bounds_value =
        (CFDictionaryRef)CFDictionaryGetValue(window, kCGWindowBounds);
    CGRect bounds = CGRectZero;
    if (bounds_value == NULL ||
        !CGRectMakeWithDictionaryRepresentation(bounds_value, &bounds) ||
        !store_active_window_bounds(bounds, &result)) {
      continue;
    }
    break;
  }
  CFRelease(windows);
#endif
  return result;
}

static void handle_interruption(int signal_number) {
  (void)signal_number;
  interrupted = 1;
  if (active_socket >= 0) {
    int socket_descriptor = (int)active_socket;
    active_socket = -1;
    const unsigned char cancellation = 0;
    ssize_t cancellation_result =
        write(socket_descriptor, &cancellation, sizeof(cancellation));
    (void)cancellation_result;
    close(socket_descriptor);
  }
}

static int install_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = handle_interruption;
  sigemptyset(&action.sa_mask);

  if (sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0) {
    return -1;
  }

  struct sigaction ignore;
  memset(&ignore, 0, sizeof(ignore));
  ignore.sa_handler = SIG_IGN;
  sigemptyset(&ignore.sa_mask);
  return sigaction(SIGPIPE, &ignore, NULL);
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

static int write_all(int file_descriptor, const void *data, size_t length) {
  const unsigned char *cursor = data;
  while (length > 0) {
    ssize_t written = write(file_descriptor, cursor, length);
    if (written > 0) {
      cursor += (size_t)written;
      length -= (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR && !interrupted) {
      continue;
    }
    if (written == 0) {
      errno = EIO;
    }
    return -1;
  }
  return 0;
}

static int read_exact(int file_descriptor, void *data, size_t length) {
  unsigned char *cursor = data;
  while (length > 0) {
    ssize_t received = read(file_descriptor, cursor, length);
    if (received > 0) {
      cursor += (size_t)received;
      length -= (size_t)received;
      continue;
    }
    if (received < 0 && errno == EINTR && !interrupted) {
      continue;
    }
    return -1;
  }
  return 0;
}

static bool retryable_connect_error(int error_number) {
  return error_number == ENOENT || error_number == ECONNREFUSED ||
         error_number == EAGAIN || error_number == ETIMEDOUT;
}

static int validate_endpoint(const char *directory, const char *endpoint) {
  struct stat metadata;
  uid_t user_id = geteuid();

  if (lstat(directory, &metadata) != 0) {
    if (errno == ENOENT) {
      return CONNECTION_RETRY;
    }
    fprintf(stderr, PMD_ERROR_PREFIX " cannot inspect CLI directory %s: %s\n", directory,
            strerror(errno));
    return CONNECTION_FATAL;
  }
  if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != user_id ||
      (metadata.st_mode & S_IRWXU) != S_IRWXU ||
      (metadata.st_mode & (S_IRWXG | S_IRWXO)) != 0) {
    fprintf(stderr,
            PMD_ERROR_PREFIX " refusing insecure CLI directory %s (it must be owned by the "
            "current user with mode 0700)\n",
            directory);
    return CONNECTION_FATAL;
  }

  if (lstat(endpoint, &metadata) != 0) {
    if (errno == ENOENT) {
      return CONNECTION_RETRY;
    }
    fprintf(stderr, PMD_ERROR_PREFIX " cannot inspect CLI socket %s: %s\n", endpoint,
            strerror(errno));
    return CONNECTION_FATAL;
  }
  if (!S_ISSOCK(metadata.st_mode) || metadata.st_uid != user_id) {
    fprintf(stderr,
            PMD_ERROR_PREFIX " refusing insecure CLI socket %s (it must be a socket owned "
            "by the current user)\n",
            endpoint);
    return CONNECTION_FATAL;
  }
  return CONNECTION_READY;
}

static int validate_peer(int socket_descriptor) {
  uid_t peer_user_id;
#ifdef __APPLE__
  gid_t peer_group_id;
  if (getpeereid(socket_descriptor, &peer_user_id, &peer_group_id) != 0) {
    return -1;
  }
#elif defined(__linux__)
  struct ucred credentials;
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(socket_descriptor, SOL_SOCKET, SO_PEERCRED, &credentials,
                 &credentials_length) != 0 ||
      credentials_length != sizeof(credentials)) {
    return -1;
  }
  peer_user_id = credentials.uid;
#else
#error "The pmd CLI helper currently supports macOS and Linux."
#endif
  if (peer_user_id != geteuid()) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static int connect_to_endpoint(const char *directory, const char *endpoint,
                               int *socket_descriptor) {
  int validation = validate_endpoint(directory, endpoint);
  if (validation != CONNECTION_READY) {
    return validation;
  }

  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot create CLI socket: %s\n", strerror(errno));
    return CONNECTION_FATAL;
  }
  (void)fcntl(descriptor, F_SETFD, FD_CLOEXEC);

  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  size_t endpoint_length = strlen(endpoint);
  if (endpoint_length >= sizeof(address.sun_path)) {
    fprintf(stderr, PMD_ERROR_PREFIX " CLI socket path is too long\n");
    close(descriptor);
    return CONNECTION_FATAL;
  }
  memcpy(address.sun_path, endpoint, endpoint_length + 1);

  active_socket = descriptor;
  if (connect(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0) {
    int connection_error = errno;
    active_socket = -1;
    close(descriptor);
    if (interrupted) {
      return CONNECTION_FATAL;
    }
    if (retryable_connect_error(connection_error)) {
      return CONNECTION_RETRY;
    }
    fprintf(stderr, PMD_ERROR_PREFIX " cannot connect to CLI socket %s: %s\n", endpoint,
            strerror(connection_error));
    return CONNECTION_FATAL;
  }

  if (validate_peer(descriptor) != 0) {
    int peer_error = errno;
    active_socket = -1;
    close(descriptor);
    fprintf(stderr, PMD_ERROR_PREFIX " refusing CLI socket with an untrusted peer: %s\n",
            strerror(peer_error));
    return CONNECTION_FATAL;
  }

  *socket_descriptor = descriptor;
  return CONNECTION_READY;
}

static char *executable_path(void) {
#ifdef __APPLE__
  uint32_t capacity = 0;
  (void)_NSGetExecutablePath(NULL, &capacity);
  if (capacity == 0) {
    return NULL;
  }
  char *unresolved = malloc((size_t)capacity);
  if (unresolved == NULL) {
    return NULL;
  }
  if (_NSGetExecutablePath(unresolved, &capacity) != 0) {
    free(unresolved);
    return NULL;
  }
  char *resolved = realpath(unresolved, NULL);
  free(unresolved);
  return resolved;
#elif defined(__linux__)
  size_t capacity = 256;
  for (;;) {
    char *path = malloc(capacity);
    if (path == NULL) {
      return NULL;
    }
    ssize_t length = readlink("/proc/self/exe", path, capacity - 1);
    if (length < 0) {
      free(path);
      return NULL;
    }
    if ((size_t)length < capacity - 1) {
      path[length] = '\0';
      return path;
    }
    free(path);
    if (capacity > 1024U * 1024U) {
      errno = ENAMETOOLONG;
      return NULL;
    }
    capacity *= 2;
  }
#endif
}

static bool remove_last_path_component(char *path) {
  size_t length = strlen(path);
  while (length > 1 && path[length - 1] == '/') {
    path[--length] = '\0';
  }
  char *separator = strrchr(path, '/');
  if (separator == NULL) {
    return false;
  }
  if (separator == path) {
    path[1] = '\0';
  } else {
    *separator = '\0';
  }
  return true;
}

static char *default_app_executable(void) {
  char *helper_path = executable_path();
  if (helper_path == NULL) {
    return NULL;
  }
  for (int level = 0; level < 3; level++) {
    if (!remove_last_path_component(helper_path)) {
      free(helper_path);
      errno = ENOENT;
      return NULL;
    }
  }

#ifdef __APPLE__
  static const char suffix[] = "/MacOS/" PMD_APP_EXECUTABLE_NAME;
#elif defined(__linux__)
  static const char suffix[] = "/" PMD_APP_EXECUTABLE_NAME;
#endif
  size_t root_length = strlen(helper_path);
  if (root_length > SIZE_MAX - sizeof(suffix)) {
    free(helper_path);
    errno = ENAMETOOLONG;
    return NULL;
  }
  char *app_path = realloc(helper_path, root_length + sizeof(suffix));
  if (app_path == NULL) {
    free(helper_path);
    return NULL;
  }
  memcpy(app_path + root_length, suffix, sizeof(suffix));
  return app_path;
}

/*
 * This runs only in the post-fork child, so keep error reporting to the
 * async-signal-safe write primitive. A short write is unlikely for an int-sized
 * pipe payload, but completing it costs little and makes the parent-side launch
 * result deterministic.
 */
static void write_launch_error(int descriptor, int launch_error) {
  const unsigned char *cursor = (const unsigned char *)&launch_error;
  size_t remaining = sizeof(launch_error);
  while (remaining > 0) {
    ssize_t written = write(descriptor, cursor, remaining);
    if (written > 0) {
      cursor += written;
      remaining -= (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    return;
  }
}

static int launch_app(const char *app_path) {
  int error_pipe[2];
  if (pipe(error_pipe) != 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot prepare app launch: %s\n", strerror(errno));
    return -1;
  }
  int protected_write_descriptor =
      fcntl(error_pipe[1], F_DUPFD_CLOEXEC, STDERR_FILENO + 1);
  if (protected_write_descriptor < 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot prepare app launch: %s\n", strerror(errno));
    close(error_pipe[0]);
    close(error_pipe[1]);
    return -1;
  }
  close(error_pipe[1]);
  error_pipe[1] = protected_write_descriptor;
  (void)fcntl(error_pipe[0], F_SETFD, FD_CLOEXEC);

  pid_t first_child = fork();
  if (first_child < 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot launch app: %s\n", strerror(errno));
    close(error_pipe[0]);
    close(error_pipe[1]);
    return -1;
  }

  if (first_child == 0) {
    close(error_pipe[0]);
    if (setsid() < 0) {
      int launch_error = errno;
      write_launch_error(error_pipe[1], launch_error);
      _exit(127);
    }

    pid_t detached_child = fork();
    if (detached_child < 0) {
      int launch_error = errno;
      write_launch_error(error_pipe[1], launch_error);
      _exit(127);
    }
    if (detached_child > 0) {
      _exit(0);
    }

    int null_descriptor = open("/dev/null", O_RDWR);
    if (null_descriptor < 0 || dup2(null_descriptor, STDIN_FILENO) < 0 ||
        dup2(null_descriptor, STDOUT_FILENO) < 0 ||
        dup2(null_descriptor, STDERR_FILENO) < 0) {
      int launch_error = errno;
      write_launch_error(error_pipe[1], launch_error);
      _exit(127);
    }
    if (null_descriptor > STDERR_FILENO) {
      close(null_descriptor);
    }
    if (chdir("/") != 0) {
      int launch_error = errno;
      write_launch_error(error_pipe[1], launch_error);
      _exit(127);
    }
    execl(app_path, app_path, "--pmd-cli-server", (char *)NULL);
    int launch_error = errno;
    write_launch_error(error_pipe[1], launch_error);
    _exit(127);
  }

  close(error_pipe[1]);
  int wait_status = 0;
  while (waitpid(first_child, &wait_status, 0) < 0) {
    if (errno == EINTR && !interrupted) {
      continue;
    }
    close(error_pipe[0]);
    return -1;
  }

  int launch_error = 0;
  ssize_t error_length;
  do {
    error_length = read(error_pipe[0], &launch_error, sizeof(launch_error));
  } while (error_length < 0 && errno == EINTR && !interrupted);
  close(error_pipe[0]);

  if (interrupted) {
    return -1;
  }
  if (error_length > 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot launch %s: %s\n", app_path,
            strerror(launch_error));
    return -1;
  }
  if (error_length < 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot confirm app launch: %s\n", strerror(errno));
    return -1;
  }
  return 0;
}

static int64_t monotonic_milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return -1;
  }
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int sleep_for_retry(void) {
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 25 * 1000 * 1000};
  while (nanosleep(&delay, &delay) != 0) {
    if (errno != EINTR || interrupted) {
      return -1;
    }
  }
  return 0;
}

static int send_u32(int socket_descriptor, uint32_t value) {
  uint32_t network_value = htonl(value);
  return write_all(socket_descriptor, &network_value, sizeof(network_value));
}

static int send_u64(int socket_descriptor, uint64_t value) {
  unsigned char network_value[8];
  for (size_t index = 0; index < sizeof(network_value); index++) {
    network_value[sizeof(network_value) - index - 1] =
        (unsigned char)(value & 0xffU);
    value >>= 8U;
  }
  return write_all(socket_descriptor, network_value, sizeof(network_value));
}

static int prepare_stdin(const char *directory, int *stdin_descriptor,
                         uint64_t *stdin_length) {
  struct stat input_stats;
  off_t input_offset = lseek(STDIN_FILENO, 0, SEEK_CUR);
  if (input_offset >= 0 && fstat(STDIN_FILENO, &input_stats) == 0 &&
      S_ISREG(input_stats.st_mode) && input_stats.st_size >= input_offset) {
    uintmax_t remaining =
        (uintmax_t)input_stats.st_size - (uintmax_t)input_offset;
    if (remaining > 0 && remaining <= UINT64_MAX) {
      int descriptor = dup(STDIN_FILENO);
      if (descriptor < 0) {
        fprintf(stderr, PMD_ERROR_PREFIX " cannot duplicate redirected stdin: %s\n",
                strerror(errno));
        return -1;
      }
      (void)fcntl(descriptor, F_SETFD, FD_CLOEXEC);
      *stdin_descriptor = descriptor;
      *stdin_length = (uint64_t)remaining;
      return 0;
    }
  }

  static const char suffix[] = "/pmd-stdin-XXXXXX";
  size_t directory_length = strlen(directory);
  if (directory_length > SIZE_MAX - sizeof(suffix)) {
    fprintf(stderr, PMD_ERROR_PREFIX " CLI stdin spool path is too long\n");
    return -1;
  }

  char *template_path = malloc(directory_length + sizeof(suffix));
  if (template_path == NULL) {
    fprintf(stderr, PMD_ERROR_PREFIX " out of memory while preparing stdin\n");
    return -1;
  }
  memcpy(template_path, directory, directory_length);
  memcpy(template_path + directory_length, suffix, sizeof(suffix));

  int descriptor = mkstemp(template_path);
  if (descriptor < 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot create the CLI stdin spool: %s\n",
            strerror(errno));
    free(template_path);
    return -1;
  }
  (void)fcntl(descriptor, F_SETFD, FD_CLOEXEC);
  if (fchmod(descriptor, S_IRUSR | S_IWUSR) != 0 ||
      unlink(template_path) != 0) {
    int spool_error = errno;
    close(descriptor);
    (void)unlink(template_path);
    free(template_path);
    fprintf(stderr, PMD_ERROR_PREFIX " cannot secure the CLI stdin spool: %s\n",
            strerror(spool_error));
    return -1;
  }
  free(template_path);

  uint64_t total_length = 0;
  unsigned char buffer[64U * 1024U];
  for (;;) {
    ssize_t length = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (length > 0) {
      if (total_length > UINT64_MAX - (uint64_t)length) {
        close(descriptor);
        fprintf(stderr, PMD_ERROR_PREFIX " redirected stdin is too large\n");
        return -1;
      }
      if (write_all(descriptor, buffer, (size_t)length) != 0) {
        int spool_error = errno;
        close(descriptor);
        fprintf(stderr, PMD_ERROR_PREFIX " cannot spool redirected stdin: %s\n",
                strerror(spool_error));
        return -1;
      }
      total_length += (uint64_t)length;
      continue;
    }
    if (length == 0) {
      break;
    }
    if (errno == EINTR && !interrupted) {
      continue;
    }
    int spool_error = errno;
    close(descriptor);
    if (!interrupted) {
      fprintf(stderr, PMD_ERROR_PREFIX " cannot read redirected stdin: %s\n",
              strerror(spool_error));
    }
    return -1;
  }

  if (lseek(descriptor, 0, SEEK_SET) < 0) {
    int spool_error = errno;
    close(descriptor);
    fprintf(stderr, PMD_ERROR_PREFIX " cannot rewind the CLI stdin spool: %s\n",
            strerror(spool_error));
    return -1;
  }
  *stdin_descriptor = descriptor;
  *stdin_length = total_length;
  return 0;
}

static int send_request(int socket_descriptor, int argument_count,
                        char *const arguments[], const char *cwd,
                        int stdin_descriptor, uint64_t stdin_length,
                        const struct active_window_bounds *active_window) {
  bool stdin_present = stdin_descriptor >= 0;
  if (write_all(socket_descriptor, protocol_magic, sizeof(protocol_magic)) != 0 ||
      send_u32(socket_descriptor, PMD_PROTOCOL_VERSION) != 0 ||
      send_u32(socket_descriptor, (uint32_t)argument_count) != 0 ||
      send_u32(socket_descriptor, (uint32_t)strlen(cwd)) != 0) {
    return -1;
  }

  unsigned char stdin_flag = stdin_present ? 1U : 0U;
  unsigned char active_window_flag = active_window->valid ? 1U : 0U;
  if (write_all(socket_descriptor, &stdin_flag, sizeof(stdin_flag)) != 0 ||
      send_u64(socket_descriptor, stdin_length) != 0 ||
      write_all(socket_descriptor, &active_window_flag,
                sizeof(active_window_flag)) != 0 ||
      send_u32(socket_descriptor, (uint32_t)active_window->x) != 0 ||
      send_u32(socket_descriptor, (uint32_t)active_window->y) != 0 ||
      send_u32(socket_descriptor, (uint32_t)active_window->width) != 0 ||
      send_u32(socket_descriptor, (uint32_t)active_window->height) != 0 ||
      write_all(socket_descriptor, cwd, strlen(cwd)) != 0) {
    return -1;
  }

  for (int index = 0; index < argument_count; index++) {
    size_t length = strlen(arguments[index]);
    if (send_u32(socket_descriptor, (uint32_t)length) != 0 ||
        write_all(socket_descriptor, arguments[index], length) != 0) {
      return -1;
    }
  }

  if (stdin_present) {
    unsigned char buffer[64U * 1024U];
    uint64_t remaining = stdin_length;
    while (remaining > 0) {
      size_t requested = remaining < sizeof(buffer) ? (size_t)remaining
                                                    : sizeof(buffer);
      ssize_t length = read(stdin_descriptor, buffer, requested);
      if (length > 0) {
        if (write_all(socket_descriptor, buffer, (size_t)length) != 0) {
          return -1;
        }
        remaining -= (uint64_t)length;
        continue;
      }
      if (errno == EINTR && !interrupted) {
        continue;
      }
      if (length == 0) {
        errno = EIO;
      }
      return -1;
    }
  }
  return 0;
}

static int receive_response(int socket_descriptor) {
  bool waiting = false;
  bool streaming_output = false;
  for (;;) {
    unsigned char header[6];
    if (read_exact(socket_descriptor, header, sizeof(header)) != 0) {
      if (!interrupted) {
        fprintf(stderr, PMD_ERROR_PREFIX " the app closed the CLI connection unexpectedly\n");
      }
      return -1;
    }

    uint32_t network_length;
    memcpy(&network_length, header + 2, sizeof(network_length));
    uint32_t payload_length = ntohl(network_length);
    if (payload_length > PMD_MAX_RESPONSE_BYTES) {
      fprintf(stderr, PMD_ERROR_PREFIX " the app returned an oversized CLI response\n");
      return -1;
    }

    unsigned char *payload = NULL;
    if (payload_length > 0) {
      payload = malloc(payload_length);
      if (payload == NULL) {
        fprintf(stderr, PMD_ERROR_PREFIX " out of memory while reading the CLI response\n");
        return -1;
      }
      if (read_exact(socket_descriptor, payload, payload_length) != 0) {
        free(payload);
        if (!interrupted) {
          fprintf(stderr,
                  PMD_ERROR_PREFIX " the app closed the CLI connection unexpectedly\n");
        }
        return -1;
      }
      if (!valid_utf8(payload, payload_length)) {
        free(payload);
        fprintf(stderr, PMD_ERROR_PREFIX " the app returned a non-UTF-8 CLI response\n");
        return -1;
      }
    }

    unsigned char kind = header[0];
    if ((waiting && kind != 'd') || (!waiting && kind == 'd') ||
        (streaming_output && kind != 'c' && kind != 'o' && kind != 'e') ||
        (kind != 'o' && kind != 'c' && kind != 'e' && kind != 'a' &&
         kind != 'w' && kind != 'd')) {
      free(payload);
      fprintf(stderr, PMD_ERROR_PREFIX " the app returned an invalid CLI response sequence\n");
      return -1;
    }

    FILE *stream = kind == 'e' ? stderr : stdout;
    if (payload_length > 0 &&
        fwrite(payload, 1, payload_length, stream) != payload_length) {
      free(payload);
      fprintf(stderr, PMD_ERROR_PREFIX " cannot write the app's CLI response\n");
      return -1;
    }
    free(payload);
    if (fflush(stream) != 0) {
      fprintf(stderr, PMD_ERROR_PREFIX " cannot flush the app's CLI response\n");
      return -1;
    }

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

static int validate_request_arguments(int argument_count, char *const arguments[],
                                      const char *cwd) {
  if (argument_count < 0 || (uint32_t)argument_count > PMD_MAX_ARGUMENTS) {
    fprintf(stderr, PMD_ERROR_PREFIX " too many command-line arguments\n");
    return -1;
  }

  size_t cwd_length = strlen(cwd);
  if (cwd_length > PMD_MAX_CWD_BYTES ||
      !valid_utf8((const unsigned char *)cwd, cwd_length)) {
    fprintf(stderr, PMD_ERROR_PREFIX " the working directory is not valid UTF-8\n");
    return -1;
  }

  size_t total_length = 0;
  for (int index = 0; index < argument_count; index++) {
    size_t length = strlen(arguments[index]);
    if (length > PMD_MAX_ARGUMENT_BYTES ||
        total_length > PMD_MAX_ARGUMENTS_TOTAL_BYTES - length) {
      fprintf(stderr, PMD_ERROR_PREFIX " command-line arguments are too large\n");
      return -1;
    }
    if (!valid_utf8((const unsigned char *)arguments[index], length)) {
      fprintf(stderr, PMD_ERROR_PREFIX " command-line arguments must be valid UTF-8\n");
      return -1;
    }
    total_length += length;
  }
  return 0;
}

static bool request_uses_stdin(int argument_count, char *const arguments[]) {
  if (argument_count > 0 &&
      (strcmp(arguments[0], "profile") == 0 ||
       strcmp(arguments[0], "scratch") == 0)) {
    return false;
  }
  for (int index = 0; index < argument_count; index++) {
    if (strcmp(arguments[index], "-") == 0) {
      return true;
    }
  }
  return false;
}

static bool request_needs_active_window_bounds(int argument_count,
                                               char *const arguments[]) {
  for (int index = 0; index < argument_count; index++) {
    if (strcmp(arguments[index], "--") == 0) {
      break;
    }
    if (strcmp(arguments[index], "-h") == 0 ||
        strcmp(arguments[index], "--help") == 0 ||
        strcmp(arguments[index], "-V") == 0 ||
        strcmp(arguments[index], "--version") == 0 ||
        strcmp(arguments[index], "--mouse-monitor") == 0) {
      return false;
    }
  }
  if (argument_count == 0) {
    return true;
  }
  if (strcmp(arguments[0], "doctor") == 0) {
    return false;
  }
  if (strcmp(arguments[0], "profile") == 0 ||
      strcmp(arguments[0], "scratch") == 0) {
    return argument_count > 1 && strcmp(arguments[1], "open") == 0;
  }
  return true;
}

static int configure_endpoint(char *directory, size_t directory_capacity,
                              char *endpoint, size_t endpoint_capacity) {
  const char *configured_endpoint = getenv("PMD_CLI_ENDPOINT");
  if (configured_endpoint != NULL) {
    size_t endpoint_length = strlen(configured_endpoint);
    if (endpoint_length == 0 || configured_endpoint[0] != '/' ||
        configured_endpoint[endpoint_length - 1] == '/') {
      fprintf(stderr,
              PMD_ERROR_PREFIX " PMD_CLI_ENDPOINT must be an absolute Unix socket path\n");
      return -1;
    }
    if (endpoint_length >= endpoint_capacity) {
      fprintf(stderr, PMD_ERROR_PREFIX " PMD_CLI_ENDPOINT is too long\n");
      return -1;
    }
    memcpy(endpoint, configured_endpoint, endpoint_length + 1);

    const char *separator = strrchr(configured_endpoint, '/');
    size_t directory_length = (size_t)(separator - configured_endpoint);
    if (directory_length == 0) {
      if (directory_capacity < 2) {
        fprintf(stderr, PMD_ERROR_PREFIX " PMD_CLI_ENDPOINT parent path is too long\n");
        return -1;
      }
      memcpy(directory, "/", 2);
    } else {
      if (directory_length >= directory_capacity) {
        fprintf(stderr, PMD_ERROR_PREFIX " PMD_CLI_ENDPOINT parent path is too long\n");
        return -1;
      }
      memcpy(directory, configured_endpoint, directory_length);
      directory[directory_length] = '\0';
    }
    return 0;
  }

  int directory_length = snprintf(directory, directory_capacity,
                                  "/tmp/%s-%" PRIuMAX, PMD_CLI_IDENTITY,
                                  (uintmax_t)geteuid());
  if (directory_length < 0 ||
      (size_t)directory_length >= directory_capacity) {
    fprintf(stderr, PMD_ERROR_PREFIX " CLI socket directory path is too long\n");
    return -1;
  }

  int endpoint_length = snprintf(endpoint, endpoint_capacity, "%s/cli-v3.sock",
                                 directory);
  if (endpoint_length < 0 || (size_t)endpoint_length >= endpoint_capacity) {
    fprintf(stderr, PMD_ERROR_PREFIX " CLI socket path is too long\n");
    return -1;
  }
  return 0;
}

int main(int argc, char *argv[]) {
  if (install_signal_handlers() != 0) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot install signal handlers: %s\n", strerror(errno));
    return 1;
  }

  char *cwd = getcwd(NULL, 0);
  if (cwd == NULL) {
    fprintf(stderr, PMD_ERROR_PREFIX " cannot read the working directory: %s\n",
            strerror(errno));
    return 1;
  }
  if (validate_request_arguments(argc - 1, argv + 1, cwd) != 0) {
    free(cwd);
    return 1;
  }
  const struct active_window_bounds active_window =
      request_needs_active_window_bounds(argc - 1, argv + 1)
          ? capture_active_window_bounds()
          : (struct active_window_bounds){0};

  char endpoint[sizeof(((struct sockaddr_un *)0)->sun_path)];
  char socket_directory[sizeof(endpoint)];
  if (configure_endpoint(socket_directory, sizeof(socket_directory), endpoint,
                         sizeof(endpoint)) != 0) {
    free(cwd);
    return 1;
  }

  int socket_descriptor = -1;
  int connection =
      connect_to_endpoint(socket_directory, endpoint, &socket_descriptor);
  if (connection == CONNECTION_FATAL) {
    free(cwd);
    return interrupted ? 130 : 1;
  }

  char *owned_app_path = NULL;
  if (connection == CONNECTION_RETRY) {
    const char *configured_app_path = getenv("PMD_APP_EXECUTABLE");
    const char *app_path;
    if (configured_app_path == NULL || configured_app_path[0] == '\0') {
      owned_app_path = default_app_executable();
      app_path = owned_app_path;
    } else {
      owned_app_path = realpath(configured_app_path, NULL);
      app_path = owned_app_path;
    }
    if (app_path == NULL || access(app_path, X_OK) != 0) {
      const char *reported_path =
          app_path == NULL ? configured_app_path : app_path;
      fprintf(stderr,
              PMD_ERROR_PREFIX " cannot locate the Pulse MD executable%s%s\n",
              reported_path == NULL ? "" : ": ",
              reported_path == NULL ? "" : reported_path);
      free(owned_app_path);
      free(cwd);
      return 1;
    }
    if (launch_app(app_path) != 0) {
      free(owned_app_path);
      free(cwd);
      return interrupted ? 130 : 1;
    }
    free(owned_app_path);

    int64_t start = monotonic_milliseconds();
    int64_t deadline = start < 0 ? -1 : start + PMD_LAUNCH_TIMEOUT_MILLISECONDS;
    for (;;) {
      if (sleep_for_retry() != 0) {
        break;
      }
      connection =
          connect_to_endpoint(socket_directory, endpoint, &socket_descriptor);
      if (connection != CONNECTION_RETRY) {
        break;
      }
      int64_t now = monotonic_milliseconds();
      if (deadline < 0 || now < 0 || now >= deadline) {
        break;
      }
    }
  }

  if (connection != CONNECTION_READY) {
    if (!interrupted && connection != CONNECTION_FATAL) {
      fprintf(stderr,
              PMD_ERROR_PREFIX " could not connect to the app's CLI service within %d seconds\n",
              PMD_LAUNCH_TIMEOUT_MILLISECONDS / 1000);
    }
    free(cwd);
    return interrupted ? 130 : 1;
  }

  bool stdin_present = request_uses_stdin(argc - 1, argv + 1) &&
                       isatty(STDIN_FILENO) == 0;
  int stdin_descriptor = -1;
  uint64_t stdin_length = 0;
  if (stdin_present &&
      prepare_stdin(socket_directory, &stdin_descriptor, &stdin_length) != 0) {
    active_socket = -1;
    close(socket_descriptor);
    free(cwd);
    return interrupted ? 130 : 1;
  }
  if (send_request(socket_descriptor, argc - 1, argv + 1, cwd,
                   stdin_descriptor, stdin_length, &active_window) != 0) {
    if (!interrupted) {
      fprintf(stderr, PMD_ERROR_PREFIX " cannot send the CLI request: %s\n", strerror(errno));
    }
    if (stdin_descriptor >= 0) {
      close(stdin_descriptor);
    }
    active_socket = -1;
    close(socket_descriptor);
    free(cwd);
    return interrupted ? 130 : 1;
  }
  if (stdin_descriptor >= 0) {
    close(stdin_descriptor);
  }
  free(cwd);

  int exit_code = receive_response(socket_descriptor);
  active_socket = -1;
  close(socket_descriptor);
  if (interrupted) {
    return 130;
  }
  return exit_code < 0 ? 1 : exit_code;
}
