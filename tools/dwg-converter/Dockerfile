FROM debian:bookworm-slim AS build

ARG LIBREDWG_VERSION=0.13.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/libredwg
RUN curl -fsSLO "https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.gz" \
    && tar -xzf "libredwg-${LIBREDWG_VERSION}.tar.gz" --strip-components=1 \
    && ./configure --disable-write \
    && make -j"$(nproc)" \
    && make install DESTDIR=/install

FROM debian:bookworm-slim

COPY --from=build /install/usr/local/ /usr/local/
RUN ldconfig && dwgread --version

ENTRYPOINT ["dwgread"]
