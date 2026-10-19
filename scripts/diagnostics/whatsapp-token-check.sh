#!/bin/sh
# Manual only. Argument is the FULL reviewed deployed Git revision, never a secret.
set +x
exec 2>/dev/null
if ! ulimit -c 0; then
  printf '%s\n' '{"stage":"shell_runtime","error":"CORE_DUMP_GUARD_FAILED"}'
  exit 1
fi
unset NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS
unset SSLKEYLOGFILE OPENSSL_CONF LD_PRELOAD LD_LIBRARY_PATH
if ! command -v node >/dev/null; then
  printf '%s\n' '{"stage":"shell_runtime","error":"NODE_UNAVAILABLE"}'
  exit 1
fi
node "$(dirname "$0")/whatsapp-token-check.cjs" "$@"
