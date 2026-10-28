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

# The server, built and unpacked so the JVM starts from plain jars.
FROM eclipse-temurin:25-jdk-alpine@sha256:1e20ead9eec7234db293f1913438090d533ed47c0b9e12dc8c7627a802a44ed6 AS server
WORKDIR /src
COPY tools/tier3-expert-rating/server/ ./
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew --no-daemon --quiet bootJar \
  && java -Djarmode=tools -jar build/libs/survey.jar extract --destination /app

FROM eclipse-temurin:25-jre-alpine@sha256:b7528962e65d43064d8a8b67ba175367896bc948363ea2d3fcd7f10d34e1f048
RUN addgroup -S -g 1001 survey && adduser -S -D -H -u 1001 -G survey survey
WORKDIR /app
COPY --from=server /app/ ./
COPY --from=web /src/tools/tier3-expert-rating/web/dist/ ./web/
COPY tools/tier3-expert-rating/instrument.yaml ./
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
