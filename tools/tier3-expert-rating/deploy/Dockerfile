# syntax=docker/dockerfile:1
# The survey server: the Spring Boot service with the browser app and the instrument built in. The
# study itself is mounted at /study. Build from the repository root:
#   docker build -f tools/tier3-expert-rating/deploy/Dockerfile -t exgen-survey .

# The browser app, built with the repository's Bun and lockfile.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS web
WORKDIR /src
COPY package.json bun.lock bunfig.toml .bun-version ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run survey:web

# Eclipse Adoptium's official November 2026 security build fixes CVE-2026-114938.
FROM eclipse-temurin:25.0.5.1_2-jdk-noble@sha256:c7eef3dfeb81468533ea48c67bddaa8c7ca916454259e4d0d734d12bcff8e125 AS java-base
RUN java --version | grep -F 'Temurin-25.0.5.1+2'

# The server, built and unpacked so the JVM starts from plain jars.
FROM java-base AS server
WORKDIR /src
COPY tools/tier3-expert-rating/server/ ./
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew --no-daemon --quiet bootJar \
  && java -Djarmode=tools -jar build/libs/survey.jar extract --destination /app

FROM java-base AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1001 survey \
  && useradd --uid 1001 --gid survey --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin survey
WORKDIR /app
COPY --from=server /app/ ./
COPY --from=web /src/tools/tier3-expert-rating/web/dist/ ./web/
COPY tools/tier3-expert-rating/instrument.yaml ./
COPY tools/tier3-expert-rating/instruments/ ./instruments/
# `survey link | withdraw | export`, run with `docker compose exec survey survey …`.
RUN printf '#!/bin/sh\nexec java -XX:TieredStopAtLevel=1 -jar /app/survey.jar "$@"\n' > /usr/local/bin/survey \
  && chmod 755 /usr/local/bin/survey
USER survey
ENV SPRING_PROFILES_ACTIVE=prod
EXPOSE 8080
# Health on the management port, which only the container itself reaches.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["wget", "--quiet", "--output-document=/dev/null", "http://127.0.0.1:8081/actuator/health/readiness"]
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/survey.jar"]
