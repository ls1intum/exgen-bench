# The analysis environment: R and its packages at fixed versions, so a report regenerates exactly.
# Packages come from a dated Posit Package Manager snapshot of CRAN.
FROM rocker/r-ver:4.6.1@sha256:bafb3b9a72791eeeb810f0bc0472e74c7f4939b20b46c96cb7ebc6838b6a25ef

RUN Rscript -e 'options(repos = c(CRAN = "https://p3m.dev/cran/__linux__/noble/2026-10-26")); \
  install.packages(c("irrCAC", "jsonlite", "ordinal")); \
  stopifnot(packageVersion("irrCAC") == "1.4", packageVersion("ordinal") == "2026.7.26", \
    packageVersion("jsonlite") == "2.0.0")'
COPY analysis.R /analysis/analysis.R
ENTRYPOINT ["Rscript", "/analysis/analysis.R"]
