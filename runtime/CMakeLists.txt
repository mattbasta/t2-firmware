cmake_minimum_required(VERSION 3.16)
project(t2-runtime LANGUAGES C CXX)

# The Tessel 2 runtime builds on txiki.js (runtime/deps/txiki.js, our fork as a
# submodule) and adds its own sources around it. See runtime/DEPENDENCIES.md.

option(T2_STATIC_DL_STUB
    "Link a dlsym() stub: required for static musl binaries on MIPS, where libc's dlsym crashes"
    OFF)

add_subdirectory(deps/txiki.js)

if(T2_STATIC_DL_STUB)
    target_sources(tjs-cli PRIVATE src/static_dl_stub.c)
endif()

set_target_properties(tjs-cli PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
