# Mesh publication and rigid transform services

These are opt-in OOP services. They do not import game code, create a second
renderer, change Node3D parenting, or alter existing upload APIs.

## MeshUpdateBudget

`MeshUpdateBudget` is a CPU value object for **main-thread admission**, not a
background job queue, GPU fence, or transactional mesh uploader.

```dolet
budget: MeshUpdateBudget = MeshUpdateBudget()
# Reset once per publication frame/service interval; choose application policy.
budget.begin(2, 524288, 1500000)
if budget.can_publish(estimated_bytes):
    # Publish one indivisible result group using existing Engine upload APIs.
    # Only after accepting the result:
    budget.note_publication(actual_bytes)
```

- Limits are groups, bytes, and elapsed nanoseconds. Nonpositive limits are
  unlimited; estimates must be nonnegative. Default construction is unlimited.
- A group may contain several related meshes. A count limit of one does not
  promise that only one GPU upload or one allocation happens.
- The first indivisible group may exceed byte/time limits to prevent starvation.
  The deadline is soft: an upload already running cannot be preempted.
- `begin_at(...)` / `can_publish_at(...)` accept an explicit monotonic clock for
  deterministic tests. `begin` uses Dolet's platform-neutral `Time.now_ns()`.
- The caller retains deferred results and controls their versions, ownership,
  priority, and eventual atomic front/back visibility swap. Do not release a
  worker snapshot merely because publication was deferred.
- Objects are independent. Applications can share one budget among services,
  or keep distinct foreground/background budgets. No hidden global limit is
  imposed on legacy applications.

## MeshTransformGroup and Engine.set_model_matrix_group

`MeshTransformGroup` owns a CPU membership list and a matrix. Its GPU IDs are
borrowed. All member vertex buffers must already use a **common local frame**.
It is suitable for a chunked moving object, not meshes needing individual local
offsets. It does not replace the scene hierarchy or provide physics parenting.

```dolet
group: MeshTransformGroup = MeshTransformGroup.create(32)
group.add(first_mesh_id)
group.add(second_mesh_id)
group.set_matrix(Mat4.trs(10.0, 0.0, 0.0, 0.0, 45.0, 0.0, 1.0, 1.0, 1.0))
group.apply()
# Rebuild membership when meshes become visible/hidden or are replaced.
group.clear()
# At shutdown: owned buffers, then the heap object itself.
group.destroy()
Memory.free(group as i64)
```

- Fixed capacity prevents per-frame reallocation. `add` rejects negative IDs
  or capacity overflow and returns false; callers must handle incomplete lists.
- `add` is O(1); duplicate membership is allowed and has idempotent output.
- `set_matrix_raw` copies a 64-byte column-major f32 matrix; it never retains
  the source pointer. `apply` returns the number of successful member updates.
- `destroy` is idempotent for CPU buffers and does **not** destroy GPU meshes.
- For applications already maintaining a compact ID list, call
  `Engine.set_model_matrix_group(mesh_ids, count, matrix_ptr)` directly. Arrays
  are borrowed only during the call; negative/out-of-range IDs are skipped.
- Call on the main thread before render. Caller-owned arrays must remain valid
  for the specified count. An empty group or a public call before startup is safe.
- Renderer matrices remain individually owned. The bulk path avoids repeated
  facade calls and emits one cull invalidation: structural if new matrices were
  allocated, transform-only otherwise. It still performs O(n) matrix copies;
  this is not GPU shared-transform indirection or a guaranteed speedup.

## Verification

From the Kobic package directory on Windows:

```powershell
../../bin/doletc.exe tests/mesh_services_checks.dlt -o build/mesh-services-checks.exe
./build/mesh-services-checks.exe
```

The headless regression checks deterministic admission boundaries, resets,
independent matrix ownership, full matrix values, invalid IDs, structural versus
transform-only invalidation, capacity handling, and idempotent cleanup. Its
synthetic backend registry contains no Vulkan device/resources.

`tests/mesh_group_gpu_checks.dlt` is a separate, auto-exiting native window
example with no game imports. It applies repeated rigid transformations to
independent render IDs under GPU culling, verifies CPU registry matrix values,
renders several frames and exercises shutdown after group buffer cleanup.
It is not a screenshot comparison or proof of GPU pixel equivalence.

The Bitora integration additionally runs `planet_surface_gpu_checks.dlt` for
real GPU near/far publication, version rejection, mesh reuse and ownership,
and `asteroid_rider_checks.dlt` for deferred worker-result retention.

## Optional spatial coordinates

`import kobic.spatial` loads only the CPU coordinate entry point and
`kobic.math.spatial`, not the renderer umbrella. The extracted `SpacePosition`
uses i64 sectors and f64 local metres with a 1,048,576m sector span. Relative
coordinates subtract sectors before conversion, retaining nearby detail at
large absolute addresses. The inherited helpers and SpatialFrame API are kept
unchanged for application compatibility.

`SpatialFrame` is caller-managed metadata; its parent ID does not perform
hierarchical composition. Its existing `destroy()` frees the heap frame itself
(do not free it twice). Integer floor helpers require a positive divisor.
Normalization expects finite local coordinates within practical sector range.
This module does not provide a render origin: f32 camera/mesh projection still
needs a separate coordinated migration involving all scene layers and physics.

```powershell
../../bin/doletc.exe tests/spatial_checks.dlt -o build/spatial-checks.exe
./build/spatial-checks.exe
```

Tests check negative/positive sector boundaries, offset round trips, nearby
precision at billion-sector addresses, vector operations and frame metadata.

## Migration boundary

These are initial extractions, not a wholesale terrain port. Reusable job
lifecycle, full hierarchical transforms, character support, large-world render
origins, and an optional smooth-density terrain module need separate migrations.
Game priorities, planetary coverage geometry, biomes, tools, inventory and
gravity tuning remain application code. New services continue through Engine /
EngineRuntime / Renderer; Vulkan ownership stays in the backend.

### Verification notes (2026-10-02)

- Normal Dolet builds, headless mesh/spatial tests, the native group test, and
  Bitora GPU publication/rider regressions are used for this migration.
- An attempted `--tree-shake` diagnostic build failed during MLIR translation
  because `_scope_arena_push` was omitted. Tests use the ordinary build path;
  the compiler was not changed as part of this engine migration.
- No frame-rate gain or visual gameplay equivalence is claimed from this
  extraction. The new rigid submission remains O(number of member meshes).
