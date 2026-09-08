cmake_minimum_required(VERSION 3.16)
project(t2-runtime LANGUAGES C CXX)

# The Tessel 2 runtime builds on txiki.js (runtime/deps/txiki.js, our fork as a
# submodule) and adds its own sources around it. See runtime/DEPENDENCIES.md.

option(T2_STATIC_DL_STUB
    "Link a dlsym() stub: required for static musl binaries on MIPS, where libc's dlsym crashes"
    OFF)

add_subdirectory(deps/txiki.js)

# `node`: txiki's core linked as a library, with our own entrypoint on top —
# embedding rather than a patched copy of its CLI. The one seam txiki does not
# offer an embedder is the choice of entrypoint, which the fork's patch 0002 adds
# to TJSRunOptions. See runtime/docs/phase1-plan.md §1.
add_executable(t2-node
    src/main.c
    src/natives.c
    src/bundles/entry.c
    src/bundles/core_modules.c
)
target_include_directories(t2-node PRIVATE src)
target_link_libraries(t2-node tjs)
set_target_properties(t2-node PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED ON
    OUTPUT_NAME node
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

if(T2_STATIC_DL_STUB)
    target_sources(tjs-cli PRIVATE src/static_dl_stub.c)
    target_sources(t2-node PRIVATE src/static_dl_stub.c)
endif()

set_target_properties(tjs-cli PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
