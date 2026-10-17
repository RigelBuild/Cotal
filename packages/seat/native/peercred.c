#include <node_api.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/syscall.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

/* The raw syscall keeps glibc's pidfd wrappers out of the symbol floor; 424 is the same on every arch. */
#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif

static int int_arg(napi_env env, napi_callback_info info, size_t want, napi_value* argv, int32_t* out) {
  size_t argc = want;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < want) {
    napi_throw_type_error(env, NULL, "fd required");
    return 0;
  }
  if (napi_get_value_int32(env, argv[0], out) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd must be an integer");
    return 0;
  }
  return 1;
}

static napi_value Peercred(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int32_t fd = 0;
  if (!int_arg(env, info, 1, argv, &fd)) return NULL;
  struct ucred cred;
  socklen_t len = sizeof(cred);
  napi_value out;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_create_object(env, &out);
  napi_value v;
  napi_create_int32(env, cred.pid, &v);
  napi_set_named_property(env, out, "pid", v);
  napi_create_uint32(env, cred.uid, &v);
  napi_set_named_property(env, out, "uid", v);
  napi_create_uint32(env, cred.gid, &v);
  napi_set_named_property(env, out, "gid", v);
  return out;
}

static napi_value TryLockFd(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int32_t fd = 0;
  if (!int_arg(env, info, 1, argv, &fd)) return NULL;
  napi_value out;
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
    napi_get_boolean(env, true, &out);
    return out;
  }
  if (errno == EWOULDBLOCK) {
    napi_get_boolean(env, false, &out);
    return out;
  }
  napi_throw_error(env, NULL, strerror(errno));
  return NULL;
}

static napi_value PidfdSignal(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int32_t pidfd = 0;
  if (!int_arg(env, info, 2, argv, &pidfd)) return NULL;
  char name[16];
  size_t n = 0;
  if (napi_get_value_string_utf8(env, argv[1], name, sizeof(name), &n) != napi_ok) {
    napi_throw_type_error(env, NULL, "signal must be a string");
    return NULL;
  }
  int sig;
  if (strcmp(name, "SIGTERM") == 0) sig = SIGTERM;
  else if (strcmp(name, "SIGKILL") == 0) sig = SIGKILL;
  else {
    napi_throw_type_error(env, NULL, "signal must be SIGTERM or SIGKILL");
    return NULL;
  }
  napi_value out;
  if (syscall(SYS_pidfd_send_signal, pidfd, sig, NULL, 0) == 0) {
    napi_create_string_utf8(env, "sent", NAPI_AUTO_LENGTH, &out);
    return out;
  }
  if (errno == ESRCH) {
    napi_create_string_utf8(env, "gone", NAPI_AUTO_LENGTH, &out);
    return out;
  }
  napi_throw_error(env, NULL, strerror(errno));
  return NULL;
}

static napi_value PidfdOpen(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int32_t pid = 0;
  if (!int_arg(env, info, 1, argv, &pid)) return NULL;
  napi_value out;
  if (pid <= 0) {
    napi_throw_range_error(env, NULL, "pid must be positive");
    return NULL;
  }
  long fd = syscall(SYS_pidfd_open, pid, 0);
  if (fd >= 0) {
    napi_create_int32(env, (int32_t)fd, &out);
    return out;
  }
  if (errno == ESRCH) {
    napi_get_null(env, &out);
    return out;
  }
  napi_throw_error(env, NULL, strerror(errno));
  return NULL;
}

static napi_value PidfdExited(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int32_t pidfd = 0;
  if (!int_arg(env, info, 1, argv, &pidfd)) return NULL;
  struct pollfd p = { .fd = pidfd, .events = POLLIN, .revents = 0 };
  int r = poll(&p, 1, 0);
  if (r < 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  /* POLLIN marks the exit; a reaped process may also report POLLHUP. POLLNVAL is a closed fd, not an exit. */
  if (p.revents & POLLNVAL) {
    napi_throw_error(env, NULL, "pidfd is not open");
    return NULL;
  }
  napi_value out;
  napi_get_boolean(env, (p.revents & (POLLIN | POLLHUP)) != 0, &out);
  return out;
}

static void export_fn(napi_env env, napi_value exports, const char* name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

static napi_value Init(napi_env env, napi_value exports) {
  export_fn(env, exports, "peercred", Peercred);
  export_fn(env, exports, "tryLockFd", TryLockFd);
  export_fn(env, exports, "pidfdSignal", PidfdSignal);
  export_fn(env, exports, "pidfdExited", PidfdExited);
  export_fn(env, exports, "pidfdOpen", PidfdOpen);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
