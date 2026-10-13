#!/usr/bin/env bash
set -euo pipefail
set +x

if (( EUID != 0 )); then
  printf 'Run as root: sudo /usr/local/sbin/mcp-auth-proxy-set-password\n' >&2
  exit 1
fi
if [[ ! -t 0 ]]; then
  printf 'Run from an interactive terminal; no password was read.\n' >&2
  exit 1
fi

readonly env_dir=/etc/mcp-auth-proxy
readonly env_file=/etc/mcp-auth-proxy/mcp-auth-proxy.env
if [[ ! -d "$env_dir" ]]; then
  printf 'Missing %s; install the proxy service first.\n' "$env_dir" >&2
  exit 1
fi

umask 077
password=''
confirmation=''
hash=''
temp_file=''
cleanup() {
  unset password confirmation hash
  if [[ -n "$temp_file" ]]; then
    rm -f -- "$temp_file"
  fi
}
trap cleanup EXIT

read -r -s -p 'Choose a password (20–72 characters): ' password
printf '\n'
read -r -s -p 'Confirm password: ' confirmation
printf '\n'

if [[ "$password" != "$confirmation" ]]; then
  printf 'Passwords do not match. No file was changed.\n' >&2
  exit 1
fi
if (( ${#password} < 20 )); then
  printf 'Use at least 20 characters. No file was changed.\n' >&2
  exit 1
fi

if ! hash="$(printf '%s' "$password" | /usr/bin/python3 -c '
import bcrypt
import sys

value = sys.stdin.buffer.read()
if len(value) < 20 or len(value) > 72:
    raise SystemExit("Password must contain 20–72 UTF-8 bytes for bcrypt")
sys.stdout.write(bcrypt.hashpw(value, bcrypt.gensalt(rounds=12)).decode("ascii"))
')"; then
  printf 'Could not create bcrypt hash. No file was changed.\n' >&2
  exit 1
fi
unset password confirmation

temp_file="$(mktemp "$env_dir/.mcp-auth-proxy.env.XXXXXX")"
chmod 0600 "$temp_file"
chown root:root "$temp_file"
{
  printf '%s\n' \
    'EXTERNAL_URL=https://hh-mcp.kurva-cloud.ru' \
    'LISTEN=127.0.0.1:3002' \
    'NO_AUTO_TLS=true' \
    'DATA_PATH=/var/lib/mcp-auth-proxy' \
    'HTTP_STREAMING_ONLY=true' \
    'REPOSITORY_BACKEND=local' \
    'PROXY_FORWARD_AUTHORIZATION=false'
  printf 'PASSWORD_HASH=%s\n' "$hash"
} > "$temp_file"
unset hash
mv -f -- "$temp_file" "$env_file"
temp_file=''
chown root:root "$env_file"
chmod 0600 "$env_file"

systemctl restart mcp-auth-proxy.service
if ! systemctl is-active --quiet mcp-auth-proxy.service; then
  printf 'Proxy did not become active; inspect systemctl status and journal.\n' >&2
  exit 1
fi
printf 'Bcrypt hash stored in the root-only environment file; proxy restarted.\n'
