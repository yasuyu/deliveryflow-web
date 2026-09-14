#!/bin/sh
set -eu

# A Docker volume replaces /data at runtime, so restore its owner before use.
chown node:node /data

# Run Prisma and the application as the unprivileged node user.
exec gosu node "$@"
