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

# Oracle published the November security build before Temurin's hotfix was available.
# Pin the official archive and its vendor-published SHA-256, not a floating latest URL.
# The production workflow targets linux/amd64; fail explicitly for other architectures.
FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8 AS patched-java
ARG TARGETARCH
RUN test "$TARGETARCH" = "amd64" \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates wget libfontconfig1 libfreetype6 tzdata \
  && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:3d40d69461200594380ac84c17be6224539022028730cffe043ac70c41ffd1d5 \
    https://download.oracle.com/java/25/archive/jdk-25.0.5.1_linux-x64_bin.tar.gz /tmp/jdk.tar.gz
RUN mkdir -p /opt/java/openjdk \
  && tar -xzf /tmp/jdk.tar.gz --strip-components=1 -C /opt/java/openjdk \
  && rm /tmp/jdk.tar.gz
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"
# Defense in depth: applies to the server, CLI, Gradle and diagnostic Java invocations.
ENV JAVA_TOOL_OPTIONS="-XX:-UseBASE64Intrinsics"
RUN java -version 2>&1 | grep -F '25.0.5.1' \
  && java -XX:+PrintFlagsFinal -version 2>&1 | grep -E 'UseBASE64Intrinsics[[:space:]]*=[[:space:]]*false'

# The server, built and unpacked so the JVM starts from plain jars.
FROM patched-java AS server
WORKDIR /src
COPY tools/tier3-expert-rating/server/ ./
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew --no-daemon --quiet bootJar \
  && java -Djarmode=tools -jar build/libs/survey.jar extract --destination /app

FROM patched-java AS runtime
RUN groupadd --gid 1001 survey \
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
