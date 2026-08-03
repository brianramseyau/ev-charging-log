#!/bin/sh
# linuxserver.io-style PUID/PGID handling: the container starts as root, creates/reuses
# a user+group matching the given ids, fixes ownership of the mounted data volume, then
# drops from root to that user to actually run the app. Keeps files written to /data
# owned by whichever user the host (e.g. Unraid's array) expects, instead of root.
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"

if ! getent group "$PGID" >/dev/null 2>&1; then
	addgroup -g "$PGID" appgroup
fi
GROUP_NAME=$(getent group "$PGID" | cut -d: -f1)

if ! getent passwd "$PUID" >/dev/null 2>&1; then
	adduser -D -H -u "$PUID" -G "$GROUP_NAME" appuser
fi
USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)

echo "Running as ${USER_NAME}:${GROUP_NAME} (PUID=${PUID} PGID=${PGID})"

mkdir -p /data
chown -R "$PUID":"$PGID" /data

exec su-exec "$PUID":"$PGID" "$@"
