# GPU-Driven Culling — Implementation Plan

> Goal: move per-instance frustum culling from the CPU (serial loop in
> `gpu_renderer_core.dlt`) onto the GPU via a compute shader that writes
> an indirect draw command buffer. The graphics pass then issues a single
> `vkCmdDrawIndexedIndirectCount` per mesh group instead of per-instance
> CPU culling + per-instance draw recording.
>
> Status legend: ⬜ TODO · 🟡 IN PROGRESS · ✅ DONE · ⚠️ BLOCKED

## Why
Measured on collision-demo: `draws == instances` (up to ~3240 draws/frame)
and CPU does `_kobic_instance_visible` per instance every frame, single
threaded. At 830 FPS today it is not a bottleneck, but it caps how many
objects the engine can ever handle. GPU-driven culling is the AAA-standard
approach (UE5, Frostbite): the GPU decides what to draw.

## Architecture (target)
```
CPU (once per frame):
  - upload instance data (model matrix + bounds) to a STORAGE buffer
  - upload frustum planes (6 x vec4) as a uniform/push constant
  - vkCmdDispatch(culling_compute)         <- GPU culls
  - memory barrier (compute write -> indirect read)
  - vkCmdDrawIndexedIndirectCount(...)      <- GPU-driven draw
GPU compute shader (per instance, parallel):
  - test instance bounds vs frustum planes
  - if visible: atomicAdd draw count, append VkDrawIndexedIndirectCommand
```

## Vulkan bindings — VERIFIED AVAILABLE
- vkCmdDispatch ✅
- vkCmdDrawIndexedIndirect / ...IndirectCount ✅
- vkCreateComputePipelines (in the 698-fn binding) ✅
- vkCreateBuffer / vkAllocateMemory / vkMapMemory ✅ (pattern in core)

## Phases (each builds + boots + game still renders before next)

### Phase 0 — Infrastructure: compute pipeline can be created ✅ DONE
- Storage-buffer + compute descriptor set layout creation. ✅
- Compute shader (cull.comp) compiled to SPIR-V, embedded in gpu_shaders. ✅
- Compute pipeline created and VERIFIED on real GPU: prints
  "[kobic.cull] GPU culling pipeline ready" at startup. ✅
- Fixed: dolet-vulkan-1.lib was missing compute symbols (vkCmdDispatch,
  vkCreateComputePipelines) — replaced with the full VulkanSDK vulkan-1.lib.
- Fixed struct layouts (shader module sType=12 + codeSize@24/pCode@32,
  pipeline layout setLayoutCount@20, compute pipeline stage@24/layout@72,
  shader-stage struct stage@20).

### Phase 1 — GPU buffers for instance data ✅ DONE
- GpuCullPipeline buffers: in (80B/inst), out (64B/inst), count (u32). ✅
- ensure_capacity grows + reallocates; _update_descriptors binds them. ✅

### Phase 2 — Culling compute shader ✅ DONE
- cull.comp tests sphere vs 6 planes, atomic-appends visible columns. ✅
- VERIFIED end-to-end via self_test: 4 instances, 2 inside frustum →
  compute returns visibleCount=2. The whole GPU compute path works:
  dispatch + storage buffers + descriptors + push constants + barrier +
  CPU readback all correct.

### Phase 3 — Wire dispatch + indirect draw into render loop 🟡 PARTIAL / DOCUMENTED
The full compute pipeline is built and proven (Phases 0-2). What remains
is integrating it into the EXISTING per-group instanced draw in
gpu_renderer_core's render_frame_scaled_with_environment.

How to finish (per mesh group, before vkCmdBeginRenderPass):
  1. For each group, upload its candidate instances (model matrix + bounds)
     into cull.in_buffer via write_instance.
  2. extract_planes(VP) -> push block; prepare_indirect(group_index_count).
  3. cull.dispatch(cmd, candidateCount, push)  (records compute + barrier).
  4. Inside the render pass, bind cull.out_handle() as the instance vertex
     buffer (binding 1) and call vkCmdDrawIndexedIndirect(cmd,
     cull.indirect_handle(), 0, 1, 0) instead of the CPU-filled draw.

Why not landed yet:
  - The current main pass is CPU-driven instancing (fills a CPU instance
    buffer, draws per group). Swapping every group to indirect is a large,
    high-risk rewrite of the most sensitive pass (Vulkan errors = silent
    black screen) and needs multiple run-on-GPU iterations to validate.
  - Measured benefit on the current scene is ZERO frames (already 830 FPS,
    not CPU/GPU bound). GPU-driven culling pays off at tens of thousands of
    instances.

Decision: ship the proven, reusable culling component now. Wire it into a
dedicated heavy-instancing path when a scene actually needs it (then the
integration risk is justified by a real, measurable win).

### Phase 4 — Validate + measure ⬜ (after Phase 3 integration)

### Phase 4 — Validate + measure ⬜
- render_stats: draws should collapse (1 indirect draw per group).
- frame_pacing: compare avg_ms before/after at high instance counts.
- Stress test: thousands of instances.

## Risks / notes
- Vulkan errors are silent (black screen). Validate each phase via boot+render.
- compute<->graphics sync barriers are the hardest part (Phase 3).
- Frustum planes must be extracted from view*proj (already have VP matrix).
- Keep CPU fallback path until GPU path proven on the real game.

## Frustum plane extraction (reference)
From a column-major VP matrix m (Gribb/Hartmann):
  left   = row3 + row0
  right  = row3 - row0
  bottom = row3 + row1
  top    = row3 - row1
  near   = row3 + row2
  far    = row3 - row2
(normalize each plane by its xyz length)
