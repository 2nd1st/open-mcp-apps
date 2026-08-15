# open-mcp-apps — stdio MCP server in a container.
#
# Why this file exists: directories that grade MCP servers do it by BUILDING them, not by reading
# about them. Glama runs a sandboxed build and withholds a server from search results, category
# listings, and recommendations until that build reproduces; docker/mcp-registry wants a Dockerfile
# outright. So this is a real entry point, not a badge — `docker run -i` speaks MCP over stdin.
#
#   docker build -t open-mcp-apps .
#   docker run -i --rm -v oma-data:/data open-mcp-apps
#
# TRIXIE, not bookworm, and that is the whole trick of this file. better-sqlite3 ships its own
# prebuilt binaries inside the npm tarball (eight platform/arch pairs, `prebuilds/`), and its
# loader tries those BEFORE any locally compiled copy — so which libc the base image carries is
# what decides whether this server starts at all. Measured here, not assumed:
#
#   · node:22-slim and node:24-slim are both Debian bookworm — glibc 2.36.
#   · the shipped prebuilds/linux-arm64.node needs GLIBC_2.38.
#   · so on bookworm the image builds fine and then dies on the first query with
#     "version `GLIBC_2.38' not found", which is the worst failure shape available: green build,
#     dead server, and a directory that records it as broken.
#   · node:22-trixie-slim is Debian 13 — glibc 2.41 — and the vendor's own binary just loads.
#
# Verified on BOTH architectures, because the first reader of this file is a directory's build
# sandbox and that is almost certainly linux/amd64 while this was authored on arm64: `docker build`
# plus a real `initialize` + `tools/list` over stdin returns open-mcp-apps 0.5.4 / 33 tools with an
# empty stderr on linux/arm64 and on linux/amd64 (`--platform linux/amd64`) alike.
#
# The alternative was a build stage with python3/make/g++ compiling the module from source. That
# was tried and rejected: it is a bigger image, a slower build, and it swaps a binary the vendor
# tests for one only we build. Matching the libc the prebuilt already targets is the smaller claim.
FROM node:22-trixie-slim

WORKDIR /app

# Source first, then install. The usual manifest-only layer would cache better, but this package's
# `prepare` script runs the bundler over the source tree during `npm ci` — with only package.json
# present it has nothing to bundle. Correctness over a cache hit.
COPY . .

# Full install (not --omit=dev): esbuild is a devDependency that build.mjs needs.
#
# --ignore-scripts is load-bearing, and for a reason worth writing down. better-sqlite3 13.0.1
# declares NO install or postinstall script — but it does ship a binding.gyp, and npm's answer to
# that is an IMPLICIT `node-gyp rebuild`. So a plain `npm ci` here fails at "gyp ERR! find Python"
# on an image with no toolchain, to produce a binary that is then never loaded: the loader prefers
# the shipped prebuilds/ (see the trixie note above). Skipping scripts drops a compile whose output
# was dead on arrival; it does not skip anything the server needs. The rest of the dependency tree
# is pure JavaScript (MCP SDK packages and zod), so nothing else wants a script either — and this
# package's own `prepare` hook is not a loss, because the very next line runs the bundler by hand.
RUN npm ci --ignore-scripts \
 && node build.mjs \
 && npm prune --omit=dev --ignore-scripts \
 && npm cache clean --force

# The loopback browser viewer is a desktop convenience; inside a stdio container nobody can reach
# it, so it is off by default here. Override with -e OMA_VIEWER=1 and a published port if wanted.
ENV OMA_VIEWER=0 \
    NODE_ENV=production \
    OMA_DB=/data/open-mcp-apps.db

# The store is the whole point of this server — data outlives the conversation, so it has to
# outlive the container too. Mount a volume here or the apps vanish with `docker run --rm`.
VOLUME ["/data"]

ENTRYPOINT ["node", "src/server.mjs"]
