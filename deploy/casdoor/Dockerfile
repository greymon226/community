ARG CASDOOR_BASE_IMAGE=casbin/casdoor:latest

FROM ${CASDOOR_BASE_IMAGE} AS base

FROM golang:1.25.8 AS build
ARG CASDOOR_REPOSITORY=https://github.com/casdoor/casdoor.git
ARG CASDOOR_REF=master
ARG TARGETOS=linux
ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install -y --no-install-recommends git perl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${CASDOOR_REF}" "${CASDOOR_REPOSITORY}" .

# Avoid account enumeration on the hosted login page. Casdoor's default
# password flow returns whether the user exists; keep the response generic.
RUN perl -0pi -e 's/c\.ResponseError\(fmt\.Sprintf\(c\.T\("general:The user: %s doesn\x27t exist"\), util\.GetId\(authForm\.Organization, authForm\.Username\)\)\)/c.ResponseError("账号或密码错误")/g' controllers/auth.go \
  && perl -0pi -e 's/c\.ResponseError\(err\.Error\(\)\)\n\s*return\n\s*\} else \{/if strings.Contains(err.Error(), "doesn\x27t exist") || strings.Contains(err.Error(), "password") || strings.Contains(err.Error(), "密码") {\n\t\t\tc.ResponseError("账号或密码错误")\n\t\t} else {\n\t\t\tc.ResponseError(err.Error())\n\t\t}\n\t\treturn\n\t} else {/' controllers/auth.go \
  && grep -q '账号或密码错误' controllers/auth.go

RUN ./build.sh

FROM base
ARG TARGETOS=linux
ARG TARGETARCH=amd64
USER root
COPY --from=build /src/server_${TARGETOS}_${TARGETARCH} /server
RUN chmod +x /server
USER 1000
