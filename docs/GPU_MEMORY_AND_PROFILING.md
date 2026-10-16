# GPU memory placement and profiling

## Static mesh arena pages live in VRAM

Arena pages (the shared vertex/index buffers behind static batches and
dynamic meshes) used to be host-visible, host-coherent allocations. On a
discrete GPU without resizable BAR that memory type is system RAM, so every
vertex and index fetch crossed PCIe. In Bitora (RTX 5070, 2560x1440) static
terrain then cost about 5 ns per triangle regardless of shader work:

| Experiment (static batches, ~1.1M triangles) | GPU ms |
|---|---|
| Baseline | 4.4 - 6.5 |
| Position-only vertex shader | 4.0 - 5.2 |
| Constant-colour fragment shader | 4.4 - 6.3 |
| 7 vertex attributes instead of 22 | 4.3 - 5.3 |
| Both shaders trivial + 7 attributes | 3.7 - 4.8 |
| Quarter of the pixels (render scale 0.5) | 4.2 - 5.5 |
| Same draws, one triangle each | 0.01 - 0.02 |
| **Pages in device-local memory** | **0.40 - 0.57** |

Pages are now `DEVICE_LOCAL` buffers (preferring a type that is not host
visible). Mesh data is written to host staging memory and copied with
`vkCmdCopyBuffer` at the start of the next frame's command buffer, followed
by one TRANSFER -> VERTEX_INPUT barrier, before the shadow and main passes.

- Staging uses `KOBIC_ARENA_STAGE_REGIONS` (4) regions of 16 MB, selected by
  `frame_serial`. The serial advances only after a frame recorded its
  copies, and a region comes round again only after that frame's fence was
  waited (2 frames in flight), so a region is never rewritten while copied.
- Uploads that overflow a region (streaming bursts) go to 64 MB overflow
  chunks, destroyed once their frame has completed. Few allocations, far
  below `maxMemoryAllocationCount`.
- Slice reuse still waits 8 frames, so a copy never overwrites data an
  in-flight frame reads.
- If staging or device-local allocation fails, the page falls back to the
  old mapped host page and is written directly.

Bitora fullscreen benchmark, GPU p50 (two A/B pairs): stand east
6.43/6.31 -> 1.43/1.36 ms, stand south 6.95/6.80 -> 1.53/1.44 ms, walk
backward 6.53/5.94 -> 1.40/1.36 ms. CPU frame p50 fell from 5-7 ms to
2.1-3.5 ms because the render thread no longer waits for the GPU.
`lod_texture_render_checks` (Bitora) still produces exactly the same
captures; the Kobic GPU checks pass.

`_upload_buffer` (per-mesh buffers outside the arena) still uses
host-visible memory.

## Pipeline statistics of the static batches

With `Engine.debug.gpu_timing(1)` and a device that supports
`pipelineStatisticsQuery`, one query wraps the static-batch draws each
frame. `Engine.debug.gpu_static_stat(i)` returns, for a recent frame:
0 input primitives, 1 vertex invocations, 2 clipping invocations,
3 clipping primitives, 4 fragment invocations, 5 a readback serial that
changes once per new sample (-1 when unsupported). These are what the GPU
actually processed, unlike the CPU-side render stats.

## Query results are 64-bit

`vkGetQueryPoolResults` was called with flags 8 (`PARTIAL`) under a comment
saying 64-bit. `VK_QUERY_RESULT_64_BIT` is 1. With 32-bit results the
nanosecond timestamps wrapped every ~4.3 s, which produced the occasional
negative GPU segment; the validation layer also reported
`VUID-vkGetQueryPoolResults-queryType-09439`.

## Moving instances and the static pages

Each static page copies its members' model matrices into the cull input
(`_gpu_static_refresh_models`), keyed by `gpu_static_xform_serial`. Every
`set_transform`, `set_model_matrix_raw`, `set_model_matrix` and
`set_model_matrix_group` bumped that serial, so any moving object (a mob
part, a held item, a drifting cloud deck) made every frame slot re-copy the
matrices of all static members (about 8k terrain meshes in Bitora), even
though none of them moved. Now only a move of a static-batch member (or of
any mesh before the static flag array exists) bumps the serial; other moves
only mark the dynamic candidates for their transform refresh. Joining or
leaving a batch still rebuilds the pages, which copies every model.
`tests/static_move_checks.dlt` checks the serial for each setter, without a
GPU.
