# ---- build ----
FROM node:24-alpine AS build
# better-sqlite3 has no prebuilt binary for every platform (e.g. arm64 musl), so it
# falls back to compiling from source here.
RUN apk add --no-cache python3 make g++
WORKDIR /app
# Full source is needed before `npm ci`, since its postinstall (`prepare`) script
# compiles the theme CSS and PWA icon set from files in this repo.
COPY . .
RUN npm ci
# SvelteKit's postbuild step imports every server module (including hooks.server.ts,
# which opens the db connection and runs migrations) to analyse the route graph, so
# it needs *some* writable DATABASE_URL even though this throwaway build-time
# database is discarded — the real one is set for the runtime stage below.
ENV DATABASE_URL=/tmp/build-time.db
RUN npm run build

# ---- production dependencies (separate from build, so devDependencies never ship) ----
FROM node:24-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips this package's own `prepare` script (which needs source
# files not copied here); rebuild the one native dependency that actually needs it.
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3

# ---- runtime ----
FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=/data/ev-charging-log.db
ENV TZ=Etc/UTC

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "build/index.js"]
