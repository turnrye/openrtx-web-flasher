#!/usr/bin/env bash
# Builds cskburn (serial only, unmodified) to WebAssembly with the Web Serial backend.
# Usage: ./build.sh <cskburn checkout>   (github.com/LISTENAI/cskburn, Apache-2.0, built at e00ec44)
# Output: public/cskburn/cskburn.{mjs,wasm}, committed so CI needs no Emscripten.
set -euo pipefail
S=$(cd "${1:?cskburn checkout}" && pwd)
P=$(cd "$(dirname "$0")" && pwd)
B=$P/build
E=$(dirname "$(readlink -f "$(which emcc)")")/../libexec
mkdir -p $B
# Homebrew emcc ships without a config; keep ours local.
cat > $B/emscripten.cfg <<CFG
LLVM_ROOT = '$E/llvm/bin'
BINARYEN_ROOT = '$E/binaryen'
NODE_JS = '$(which node)'
CACHE = '$B/emcache'
CFG
export EM_CONFIG=$B/emscripten.cfg
for c in castor venus arcs venusa; do
  python3 -I $S/bin2c.py $S/libcskburn_serial/burner_$c.bin $B/burner_serial_${c}_img.c burner_serial_$c
done
SRCS=(
  $S/cskburn/src/main.c $S/cskburn/src/utils.c $S/cskburn/src/verify.c
  $S/cskburn/src/read_parts_bin.c $S/cskburn/src/read_parts_hex.c $S/cskburn/src/intelhex/intelhex.c
  $S/libcskburn_serial/src/core.c $S/libcskburn_serial/src/cmd.c
  $S/libslip/src/slip.c $S/libio/src/io.c $S/libio/src/fsio.c $S/libio/src/memio.c
  $S/liblog/src/log.c $S/liblog/src/errid.c $S/liberrors/src/errors.c
  $S/libportable/src/time_monotonic.c
  $S/third/mbedtls/library/md5.c $S/third/mbedtls/library/platform_util.c
  $P/serial_web.c $B/burner_serial_*_img.c
)
INC=(-I$P/override)
for d in libserial libcskburn_serial libslip libio liblog liberrors libportable; do INC+=(-I$S/$d/include); done
INC+=(-I$S/libcskburn_serial/src -I$S/cskburn/src -I$S/third/mbedtls/include -I$S/third/mbedtls/library)
emcc -O2 -DWITHOUT_USB -DGIT_TAG=\"web-poc\" -DGIT_INCREMENT=0 "${INC[@]}" "${SRCS[@]}" -o $B/cskburn.mjs \
  -sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH -sMODULARIZE -sEXPORT_ES6 \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sENVIRONMENT=web,node \
  -sFORCE_FILESYSTEM
cp $B/cskburn.mjs $B/cskburn.wasm $P/../../public/cskburn/
