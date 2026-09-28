#!/usr/bin/env bash
# Build the FFmpeg command-line tool for one Android ABI, from source, with a
# pinned NDK.
#
# Why from source: the prebuilt this replaces (Khang-NT, 2018) was built with
# NDK r15c. Its segments were 64 KB aligned, so it passed a plain alignment
# check, but that linker ended the RELRO region on a 4 KB boundary with
# writable .data in the same 16 KB page. On a 16 KB-page device the loader's
# mprotect(RELRO) rounds out to the whole page, turns that .data read-only,
# and FFmpeg crashes on its first write there. Google Play flags every library
# built with an NDK older than r28 for exactly this. r28+ lays the segments
# out for 16 KB pages by default.
#
# What goes in is what Levix asks FFmpeg for: Opus voice notes (!tts, through
# libopus), JPEG thumbnails of the images and videos it sends, and demuxers /
# decoders for the media WhatsApp carries. Filters, parsers and bitstream
# filters keep FFmpeg's defaults.
#
# Usage: build-ffmpeg-android.sh <abi> <output-file>
#
# The build is cached under $LEVIX_NODE_CACHE/ffmpeg/, keyed by this file's
# contents: bumping a version or a flag below rebuilds, anything else reuses.
#
# Needs curl, make, pkg-config, python3, tar (xz) and unzip. The NDK is taken
# from $ANDROID_HOME/ndk/<version> when installed there (CI installs it with
# sdkmanager) and downloaded into the cache otherwise.
set -euo pipefail

ABI="${1:?usage: build-ffmpeg-android.sh <abi> <output-file>}"
OUT="${2:?usage: build-ffmpeg-android.sh <abi> <output-file>}"

CACHE="${LEVIX_NODE_CACHE:-$HOME/.cache/levix-android}"
DOWNLOADS="$CACHE/downloads"
JOBS="$(nproc 2>/dev/null || echo 4)"

# r29 is also what Termux builds the embedded Node runtime with.
NDK_VERSION="29.0.14206865"
NDK_ZIP="android-ndk-r29-linux.zip"
NDK_SHA256="4abbbcdc842f3d4879206e9695d52709603e52dd68d3c1fff04b3b5e7a308ecf"
FFMPEG_VERSION="8.1.3"
FFMPEG_SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"
OPUS_VERSION="1.6.1"
OPUS_SHA256="6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1"
# The app's minSdk: the oldest Android the binary has to start on.
API=29

DECODERS="aac,aac_fixed,aac_latm,amrnb,amrwb,bmp,flac,gif,h263,h264,hevc,mjpeg,mp3,mp3float,mpeg4,opus,pcm_f32le,pcm_s16be,pcm_s16le,pcm_u8,png,rawvideo,vorbis,vp8,vp9,webp"
ENCODERS="aac,flac,gif,libopus,mjpeg,mpeg4,pcm_s16le,png"
DEMUXERS="aac,amr,avi,flac,gif,h264,hevc,image2,image2pipe,image_bmp_pipe,image_jpeg_pipe,image_png_pipe,image_webp_pipe,matroska,mov,mp3,mpegps,mpegts,ogg,wav"
MUXERS="adts,gif,image2,image2pipe,ipod,matroska,mjpeg,mov,mp3,mp4,ogg,opus,wav,webm"

case "$ABI" in
  arm64-v8a)
    TRIPLE=aarch64-linux-android
    OPUS_HOST=aarch64-linux-android
    FF_ARCH=aarch64
    ;;
  armeabi-v7a)
    TRIPLE=armv7a-linux-androideabi
    OPUS_HOST=arm-linux-androideabi
    FF_ARCH=arm
    ;;
  *) echo "unknown ABI: $ABI (expected arm64-v8a or armeabi-v7a)" >&2; exit 1 ;;
esac

for tool in curl make pkg-config tar unzip; do
  if ! command -v "$tool" > /dev/null; then
    echo "build-ffmpeg-android.sh needs '$tool' on the PATH" >&2
    exit 1
  fi
done

STAMP="$(sha256sum "${BASH_SOURCE[0]}" | cut -c1-16)"
BUILT="$CACHE/ffmpeg/$STAMP/$ABI/ffmpeg"

install_output() {
  mkdir -p "$(dirname "$OUT")"
  cp "$BUILT" "$OUT"
  chmod 755 "$OUT"
}

if [ -f "$BUILT" ]; then
  echo "==> [$ABI] FFmpeg $FFMPEG_VERSION (cached build $STAMP)"
  install_output
  exit 0
fi

# fetch <url> <dest> <sha256> — skips the download when dest already matches.
fetch() {
  local url="$1" dest="$2" sum="$3"
  if [ -f "$dest" ] && echo "$sum  $dest" | sha256sum -c --status 2>/dev/null; then
    return
  fi
  echo "GET $url"
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 -o "$dest.part" "$url"
  if ! echo "$sum  $dest.part" | sha256sum -c --status; then
    echo "checksum mismatch for $url" >&2
    rm -f "$dest.part"
    exit 1
  fi
  mv "$dest.part" "$dest"
}

NDK=""
for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
  if [ -n "$sdk" ] && [ -f "$sdk/ndk/$NDK_VERSION/source.properties" ]; then
    NDK="$sdk/ndk/$NDK_VERSION"
    break
  fi
done
if [ -z "$NDK" ]; then
  NDK="$CACHE/ndk/android-ndk-r29"
  if [ ! -f "$NDK/source.properties" ]; then
    fetch "https://dl.google.com/android/repository/$NDK_ZIP" "$DOWNLOADS/$NDK_ZIP" "$NDK_SHA256"
    echo "==> unpacking NDK r29..."
    rm -rf "$CACHE/ndk"
    mkdir -p "$CACHE/ndk"
    unzip -q "$DOWNLOADS/$NDK_ZIP" -d "$CACHE/ndk"
    # 800 MB that is never read again once unpacked.
    rm -f "$DOWNLOADS/$NDK_ZIP"
  fi
fi
if ! grep -q "Pkg.Revision *= *$NDK_VERSION" "$NDK/source.properties"; then
  echo "NDK at $NDK is not $NDK_VERSION" >&2
  exit 1
fi

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
CC="$TOOLCHAIN/bin/${TRIPLE}${API}-clang"
AR="$TOOLCHAIN/bin/llvm-ar"
NM="$TOOLCHAIN/bin/llvm-nm"
RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
STRIP="$TOOLCHAIN/bin/llvm-strip"

fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
  "$DOWNLOADS/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" \
  "$DOWNLOADS/opus-$OPUS_VERSION.tar.gz" "$OPUS_SHA256"

WORK="$CACHE/ffmpeg/work-$ABI"
PREFIX="$WORK/prefix"
rm -rf "$WORK"
mkdir -p "$WORK"

# run <log-name> <command...> — keeps configure/make noise in a log and only
# prints its tail when the step fails.
run() {
  local log="$WORK/$1.log"
  shift
  if ! "$@" > "$log" 2>&1; then
    echo "failed: $* (last lines of $log)" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi
}

echo "==> [$ABI] building Opus $OPUS_VERSION..."
tar -xzf "$DOWNLOADS/opus-$OPUS_VERSION.tar.gz" -C "$WORK"
(
  cd "$WORK/opus-$OPUS_VERSION"
  run opus-configure ./configure \
    --host="$OPUS_HOST" \
    --prefix="$PREFIX" \
    --enable-static --disable-shared --with-pic \
    --disable-doc --disable-extra-programs \
    CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="-O2"
  run opus-make make -j"$JOBS"
  run opus-install make install
)

echo "==> [$ABI] building FFmpeg $FFMPEG_VERSION..."
tar -xJf "$DOWNLOADS/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK"
(
  cd "$WORK/ffmpeg-$FFMPEG_VERSION"
  # PKG_CONFIG_LIBDIR, not _PATH: only the Opus just built may be found, never
  # a host library for the wrong architecture.
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
  # --disable-autodetect keeps host-dependent features out; zlib is then
  # enabled by hand because the PNG codecs need it (Bionic ships libz.so).
  run ffmpeg-configure ./configure \
    --prefix="$PREFIX" \
    --target-os=android --arch="$FF_ARCH" --enable-cross-compile \
    --cc="$CC" --nm="$NM" --ar="$AR" --ranlib="$RANLIB" --strip="$STRIP" \
    --sysroot="$TOOLCHAIN/sysroot" \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --extra-cflags="-I$PREFIX/include" \
    --extra-ldflags="-L$PREFIX/lib" \
    --enable-pic --enable-small --disable-debug --disable-doc \
    --disable-shared --enable-static \
    --disable-autodetect --enable-zlib \
    --disable-network --disable-devices \
    --disable-ffplay --disable-ffprobe \
    --disable-protocols --enable-protocol=file,pipe \
    --disable-decoders --enable-decoder="$DECODERS" \
    --disable-encoders --enable-encoder="$ENCODERS" \
    --disable-demuxers --enable-demuxer="$DEMUXERS" \
    --disable-muxers --enable-muxer="$MUXERS" \
    --enable-libopus
  # A component whose dependency is missing is dropped with only a warning.
  grep '^WARNING' "$WORK/ffmpeg-configure.log" >&2 || true
  run ffmpeg-make make -j"$JOBS"
  run ffmpeg-install make install
)

mkdir -p "$(dirname "$BUILT")"
"$STRIP" --strip-unneeded -o "$BUILT" "$PREFIX/bin/ffmpeg"
rm -rf "$WORK"
# Earlier recipes' builds are dead weight in the CI cache.
find "$CACHE/ffmpeg" -mindepth 1 -maxdepth 1 -type d ! -name "$STAMP" ! -name 'work-*' \
  -exec rm -rf {} +

echo "==> [$ABI] FFmpeg $FFMPEG_VERSION built ($STAMP)"
install_output
