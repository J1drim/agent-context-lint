FROM scratch

ARG SOURCE_DATE_EPOCH=1786312800
ADD .h13-runtime-inputs-reviewed/base-rootfs.v1.tar.gz /
ADD .h13-runtime-inputs-reviewed/runtime-overlay.v1.tar.gz /
ENV NODE_VERSION=24.18.1 \
  YARN_VERSION=1.22.22 \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH

WORKDIR /opt/h13/repo
ENTRYPOINT ["/usr/local/bin/node", "/opt/h13/runner.mjs"]
