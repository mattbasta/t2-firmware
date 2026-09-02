# CMake toolchain file: OpenWrt SDK, ramips/mt7620 (mipsel_24kc, soft-float, musl).
#
# Expects TOOLCHAIN_DIR to point at the SDK's
# staging_dir/toolchain-mipsel_24kc_gcc-<ver>_musl directory (set by
# runtime/scripts/build-cross.sh, or pass -DTOOLCHAIN_DIR=... by hand).
# The OpenWrt compiler wrappers also require STAGING_DIR in the environment.
#
# The result is a fully static binary: the dependency policy forbids dynamic
# dependencies beyond musl/libgcc (runtime/DEPENDENCIES.md, "No system
# libraries"), and a static musl binary also runs unchanged on the original
# uClibc-era Tessel 2 firmware, which matters for side-by-side measurements
# against Node 8.

set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR mipsel)

if(NOT TOOLCHAIN_DIR)
    set(TOOLCHAIN_DIR "$ENV{TOOLCHAIN_DIR}")
endif()
if(NOT TOOLCHAIN_DIR)
    message(FATAL_ERROR "TOOLCHAIN_DIR not set (see runtime/cmake/openwrt-mipsel.cmake)")
endif()

set(triple mipsel-openwrt-linux-musl)
set(CMAKE_C_COMPILER   "${TOOLCHAIN_DIR}/bin/${triple}-gcc")
set(CMAKE_CXX_COMPILER "${TOOLCHAIN_DIR}/bin/${triple}-g++")
set(CMAKE_AR           "${TOOLCHAIN_DIR}/bin/${triple}-ar")
set(CMAKE_RANLIB       "${TOOLCHAIN_DIR}/bin/${triple}-ranlib")
set(CMAKE_STRIP        "${TOOLCHAIN_DIR}/bin/${triple}-strip")

set(CMAKE_FIND_ROOT_PATH "${TOOLCHAIN_DIR}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# MIPS32 has no native 64-bit atomics; quickjs-ng and libuv reach libatomic.
# The OpenWrt quickjs package declares the same dependency. It must come after
# the static archives that use it, so it goes in STANDARD_LIBRARIES (end of the
# link line), not in the linker flags (start of it).
#
# OpenWrt's gcc specs omit -lgcc_eh under -static (their unwinder ships in the
# shared libgcc_s), so libstdc++'s exception personality would otherwise fail to
# link. Name it explicitly — after -lstdc++, so the personality objects are
# pulled in before the static unwinder archive is scanned.
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static")
set(CMAKE_C_STANDARD_LIBRARIES_INIT   "-latomic")
set(CMAKE_CXX_STANDARD_LIBRARIES_INIT "-latomic -lstdc++ -lgcc_eh")
set(CMAKE_C_FLAGS_INIT   "-msoft-float")
set(CMAKE_CXX_FLAGS_INIT "-msoft-float")
