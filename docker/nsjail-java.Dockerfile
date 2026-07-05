FROM eclipse-temurin:21

RUN apt-get update && apt-get install -y \
    autoconf \
    bison \
    flex \
    gcc \
    g++ \
    git \
    libprotobuf-dev \
    libnl-route-3-dev \
    libtool \
    make \
    pkg-config \
    protobuf-compiler

RUN git clone https://github.com/google/nsjail.git /opt/nsjail && \
    cd /opt/nsjail && \
    make

# ── AppCDS: pre-generate the JDK shared class-data archive ───────────────────
# This maps JDK core classes read-only at startup, cutting JVM cold-boot by
# ~200-400ms per invocation. The archive is generated once at image build time
# and stored at /opt/java/openjdk/lib/server/classes.jsa (default location).
# At runtime we pass -Xshare:on to use it.
RUN java -XX:+UnlockDiagnosticVMOptions \
         -XX:SharedArchiveFile=/opt/java/openjdk/lib/server/classes.jsa \
         -Xshare:dump \
         -XX:TieredStopAtLevel=1 \
         -XX:+UseSerialGC \
    2>/dev/null || true

WORKDIR /workspace