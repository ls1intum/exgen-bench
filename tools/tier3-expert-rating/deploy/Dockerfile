# The survey server: exgen-bench at one commit, with its browser app built in.
# Build from the repository root:
#   docker build -f tools/tier3-expert-rating/deploy/Dockerfile -t exgen-survey .
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

WORKDIR /app
COPY package.json bun.lock bunfig.toml .bun-version ./
RUN bun install --frozen-lockfile
COPY . .
# The browser app is built once here; `survey serve` uses it while its sources are unchanged.
RUN bun run survey:web \
  && printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/exgen \
  && chmod 755 /usr/local/bin/exgen \
  && mkdir /data \
  && chown bun:bun /data

USER bun
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
VOLUME /data
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:4180/healthz'); process.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["exgen", "survey", "serve", "/study", "--db", "/data/survey.sqlite", "--hostname", "0.0.0.0"]
