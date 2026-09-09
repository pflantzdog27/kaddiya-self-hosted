# Kaddiya console — production image for Railway (docs/deploy/kaddiya-com.md).
#
# One container, one process: `node server/index.js`. No build step (the
# frontend is plain browser JS served from public/), so the image is the
# checked-in tree plus production dependencies.
#
# Built and booted locally on 2026-09-03 (547 MB image, throwaway Postgres 16,
# migrations applied, volume symlinks resolved). If a Railway build fails, the
# build log is the place to look, and every line below is deliberate.

FROM node:22-bookworm-slim

# git: server/docs.js shells out to `git clone --sparse` (the ServiceNow docs
# corpus into docs-cache/) and to `git grep` for search. ca-certificates: that
# clone is over HTTPS from github.com.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The docs sparse clone (a partial clone with --filter=blob:none) has failed
# on first boot with "curl 92 HTTP/2 stream was not closed cleanly" from
# github.com; git over HTTP/1.1 does not hit it.
RUN git config --system http.version HTTP/1.1

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so the layer is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Everything .dockerignore does not exclude: server/, public/, docs-fluent/
# (the checked-in Fluent SDK corpus the docs tools read at runtime), scripts/.
COPY . .

# ---- persistence: one Railway volume at /data ----
#
# Two directories must outlive a deploy:
#   /app/docs-cache  server/docs.js resolves it relative to server/; holds the
#                    sparse clone of ServiceNowDocs (re-cloned at every boot
#                    if it is missing — minutes of git traffic we do not want
#                    on each deploy).
#   /app/data        server/keys.js resolves it the same way; only used for
#                    the generated development master key when
#                    KADDIYA_MASTER_KEY is unset. In production the key comes
#                    from the variable, so this stays empty — but it must be
#                    writable so a missing variable fails loudly with a
#                    warning instead of an EROFS.
# Railway mounts exactly one volume per service, at a path you choose. We
# mount it at /data and point both app paths into it with symlinks, so the
# server code stays unaware of the deployment shape. Any local docs-cache/ or
# data/ copied by mistake is removed first (.dockerignore excludes them, but
# a stale symlink target is worse than an extra rm).
RUN rm -rf /app/docs-cache /app/data \
  && mkdir -p /data \
  && ln -s /data/docs-cache /app/docs-cache \
  && ln -s /data/data /app/data

# The volume is empty on first boot, and symlinks to missing directories are
# dangling, so the entrypoint creates both targets before starting node. The
# script is written here (not a separate file) to keep the deploy surface to
# the files listed in the runbook.
RUN printf '%s\n' \
  '#!/bin/sh' \
  '# Kaddiya entrypoint: make the volume-backed directories, then run the CMD.' \
  'set -e' \
  'mkdir -p /data/docs-cache /data/data' \
  'exec "$@"' \
  > /usr/local/bin/kaddiya-entrypoint \
  && chmod +x /usr/local/bin/kaddiya-entrypoint

# ---- user: root, deliberately ----
#
# Railway mounts volumes owned by root. A `USER node` here would make the
# entrypoint's mkdir on /data fail on first boot, and Railway's documented
# answer is the RAILWAY_RUN_UID=0 variable, which runs the container as root
# anyway. Running as root outright is the same outcome without a variable
# that can be forgotten. The tradeoff: a process compromise inside the
# container is a root process inside that container. What bounds it is the
# container itself (no shell exposed, no other services in it) and the app's
# own posture: no ServiceNow write path outside the action catalog, no
# durable tokens, secrets only in environment variables. Revisit if Railway
# adds per-volume ownership; the fix is `USER node` plus a chown in the
# entrypoint.

# Railway injects PORT; server/index.js reads process.env.PORT (default 3000).
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/kaddiya-entrypoint"]
CMD ["node", "server/index.js"]
