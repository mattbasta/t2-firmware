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
    src/fs.c
    src/constants.c
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

# txiki applies its size options to its own CLI target only, so ours has to opt
# in explicitly. Without the link half of this the binary carries every unused
# function in the archives: it measured 1.2 MB larger than the same build with
# --gc-sections, for a change that added 114 KB of bytecode.
if(BUILD_WITH_GC_SECTIONS)
    target_compile_options(t2-node PRIVATE -ffunction-sections -fdata-sections)

    if(MSVC)
        target_link_options(t2-node PRIVATE /OPT:REF /OPT:ICF)
    elseif(APPLE)
        target_link_options(t2-node PRIVATE -Wl,-dead_strip)
    else()
        target_link_options(t2-node PRIVATE -Wl,--gc-sections)
    endif()
endif()

# txiki strips only its own CLI; do the same for ours when the option is on.
if(BUILD_WITH_STRIP AND CMAKE_STRIP)
    add_custom_command(TARGET t2-node POST_BUILD
        COMMAND ${CMAKE_STRIP} $<TARGET_FILE:t2-node>)
endif()

set_target_properties(tjs-cli PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
