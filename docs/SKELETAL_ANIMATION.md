# Skeletal meshes and camera booms

Frog exposes `Skeleton3D`, `SkinnedMesh3D`, and `SpringArm3D` as reusable
object-style services. These contain no Bitora, planet, terrain, or player rules.

## GPU skinning

`SkinnedMesh3D.load(path)` loads a validated `.frogskin` asset through `Assets`.
Check `mesh.mesh_id >= 0` before using it; `mesh.error` describes failures.
The mesh starts hidden. Bind a material/texture and publish a root model matrix
using the existing Engine mesh APIs, then make it visible.

`mesh.skeleton_ptr as Skeleton3D` provides two pose paths:

- `configure_joint(index, parent, local_bind, inverse_bind)` requires parents
  before children and rejects cycles. `set_local_pose` followed by `evaluate`
  evaluates the hierarchy and uploads `jointModel * inverseBind` palettes.
- `set_deformation(index, matrix)` accepts that already-solved deformation
  directly, for procedural animation and IK controllers.

The vertex shader blends up to four joint influences. Geometry, indices, UVs,
and weights are uploaded once; poses do not rebuild or upload vertex buffers.
Classic, bindless, and bindless-SSBO main vertex shaders use the same palette.
The existing 44-byte vertex and 128-byte instance layouts retain their sizes;
the formerly reserved instance word at byte 116 now identifies a skin record.
Static meshes use zero and bypass deformation.

Two fence-owned, persistently mapped 4 MiB GPU buffers keep in-flight poses
isolated. Immutable influences are copied once per slot; thereafter only live
joint matrices are copied. There is no per-pose allocation, queue-idle wait,
readback, or GPU vertex regeneration. CPU staging is allocated at first skin
use; the current renderer reserves 8 MiB GPU storage even for non-skinned scenes.
The pool supports 256 allocation slots, 128 joints per mesh, and 4 MiB total
records. Compatible retired allocations are reused. `destroy()` hides the mesh,
releases its pose allocation, and frees the skeleton; geometry follows the
renderer's existing engine-owned lifetime until shutdown.

## Offline asset format

```powershell
python tools/frog_skin_cooker.py source.gltf destination.frogskin
```

The cooker requires NumPy. Version 1 accepts one external-buffer glTF 2.0,
one indexed triangle primitive, one skin, four influences, an identity mesh
node, and parent-ordered rigid joint binds. Supply POSITION, NORMAL, TEXCOORD_0,
JOINTS_0, WEIGHTS_0, indices, and inverseBindMatrices. Vertex colors are white;
texture/material assignment is explicit at runtime. The runtime validates exact
section sizes, bounds, finite values, normalized weights, and ordered parents
before creating GPU resources. File sections are a 48-byte FRSK/v1 header,
44-byte vertices, 32-byte influences, uint32 indices, and 144-byte joint records.
Matrices are column-major.

This is a bounded procedural-skinning foundation, not a general glTF animation
player: GLB, multiple primitives, morph targets, non-rigid joint scaling, and
animation clip playback are not supported. Conservative animated culling bounds
are installed at load; unusually large pose excursions need caller-adjusted
bounds. Skinned shadow casting/receiving is disabled by default because the
shadow shaders do not yet deform vertices. Keep those flags disabled.

## SpringArm3D

`resolve(clearance, dt)` retracts immediately when blocked and eases outward
when released, returning a length in `[0, desired_length]`. The caller supplies
collision clearance in world units; Frog does not assume a collision shape,
terrain backend, character capsule, or input binding. It never moves physics.

Regression: compile/run `tests/skeleton_checks.dlt` from the compiler workspace.
Bitora additionally has native classic/bindless world replays and pose/foot tests.
