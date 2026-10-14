# Kobic Engine

**100% OOP 3D game engine for Dolet. No ECS.**

Kobic is a deliberate architectural counterpart to Kobic: same engine scope
(3D rendering, input, math, scene graph) but organised as a classic
object-oriented framework instead of an Entity-Component-System.

Every "thing" in a Kobic game is used through an object-style API:

```dolet
scene: Scene = Scene.create(20000)
goblin: GameObject = scene.spawn("goblin")
goblin.position(1.0, 0.0, 3.0)
goblin.velocity(2.0, 0.0, 0.0)
scene.update_all(dt)
```

## What it is NOT

- **Not an ECS.** No archetypes, no component storages, no queries.
- **Not a thin wrapper around Kobic.** Kobic imports zero Kobic source files.
  It only shares the same OS-level packages (Vulkan bindings, window
  bindings, input bindings) that any independent engine would need.

## Status

**Alpha - under active construction.** See `ROADMAP.md` for the build plan.

Phase 0 (directory structure + roadmap) is complete. Phase 1 (math library)
and the first OOP shell are now in place.

Current local shape:

- Math primitives are available (`Vec3`, `Mat4`, `Quat`, `Color`).
- `AppWindow`, `Clock`, `App`, and `Input` provide the first app shell.
- `Scene` + `GameObject` provide OOP user code over packed object storage.
- `SoftwareRenderer` provides a basic framebuffer renderer for early demos.
- `Engine` owns the public static lifecycle and hides the Vulkan runtime backend.
- `Engine.window`, `Engine.properties`, and `Engine.scene` group public setup APIs.
- `Engine.properties.set_vsync(1/0)` controls synced vs uncapped swapchain presentation.
- `Engine.properties.set_present_mode(PresentMode.mailbox())` can explicitly request Vulkan presentation mode.
- `Engine.properties.active_present_mode()` reports the Vulkan mode actually selected by the swapchain after startup.
- `Engine.debug.frame_pacing(1)` prints frame-time min/avg/max, spikes, present mode, target FPS, and render scale.
- `Assets` groups public resource loading APIs for models, textures, audio, and shaders.
- `DirectionalLight3D` drives GPU diffuse/specular sunlight with color, intensity, direction, and ambient control.
- `PointLight3D` provides up to eight local color lights per scene with position, energy, and range controls.
- `ShadowSettings` defines shadow-map quality for the upcoming depth pipeline.
- `Material3D` applies albedo, emissive, and unlit state per instance while preserving batching; roughness and metallic are staged for the PBR pass.
- `Shader3D` is the public shader descriptor name for advanced material pipelines.
- `ObjectBench` measures update throughput before rendering.

Vulkan rendering is available through the `Engine` facade while lower-level
runtime/backend types remain internal package plumbing.

## Opt-in dynamic mesh services

`Debug.line(a, b, color)` adds bounded frame-local, depth-tested world-space
lines to the existing collision debug pass (`Debug.collisions(1)`). It reuses
the ray-line pipeline, allocates lazily, and does no work while disabled.

`MeshParticles3D` provides reusable shared-mesh debris pools with fixed-step
ballistics, external collision results, sleeping and render interpolation.
It does not add an ECS or a global physics loop. See
[mesh particles](docs/MESH_PARTICLES.md) for ownership and limits.

`Skeleton3D` and `SkinnedMesh3D` provide frame-isolated GPU skeletal deformation;
`SpringArm3D` provides a collision-clearance-driven camera boom. See
[skeletal animation](docs/SKELETAL_ANIMATION.md) for the offline cooker, API,
limits, ownership, and regression checks.

- `MeshUpdateBudget`: reusable main-thread count/byte/time admission for
  indivisible publication groups. Application priority and result ownership
  remain with the caller; it is not a job queue or atomic upload transaction.
- `MeshTransformGroup`: OOP rigid membership with a common local vertex frame.
  `Engine.set_model_matrix_group(ids, count, matrix)` also supports existing
  compact membership lists without creating another list.

Existing upload, transform, and Node3D APIs retain their behavior. See
[Mesh service contracts and tests](docs/MESH_SERVICES.md).

Large-world coordinate math is separately opt-in with `import kobic.spatial`:
`SpacePosition`, `SpatialVector`, and `SpatialFrame` have no renderer/window
dependencies. This does not automatically rebase the scene or camera.

## Dependencies

- `json` package - general JSON parsing for glTF metadata
- `vulkan` package - Vulkan C API bindings
- `window` package - Win32 window + vulkan surface

## Obin workflow

Kobic is an engine package rather than a second project manager. Dolet
applications use Obin as their single project interface. Obin packs every file
under the application's asset roots into one `.dpk` beside the executable on
every build, debug and release alike, cooking textures and models on the way
with the pure-Dolet cooker it builds from this package:

```powershell
obin build
obin run
obin package --profile release
```

Enable cooking in the application manifest:

```toml
[tool.kobic]
enabled = true
cook-models = true
cook-textures = true
texture-excludes = ["@channels="] # stored as PNG instead of cooked
# Optional overrides; filename inference handles common normal/MR/AO names.
texture-normal-patterns = ["_n.png", "normal.png"]
texture-metallic-roughness-patterns = ["metallicRoughness.png"]
texture-occlusion-patterns = ["_ao.png"]
texture-lossless-patterns = ["ui/pixel-art/"]
lods = [0.45, 0.22]
```

Each PNG enters the pack as KobicTexture v2 with a complete offline mip chain,
under its own name. Color and general data use BC7, tangent-space normals and
glTF metallic-roughness use BC5, single-channel occlusion uses BC4, and
explicit `lossless` overrides use RGBA8. Each glTF/GLB enters as a cooked model
with its LODs. Nothing is written beside the sources.

### Where assets are read from

Every asset read in the engine goes through `AssetFiles`. When the program has
a pack (`<program>.dpk` beside the executable, or appended to it), the pack is
the only source: `Assets.textures.load("textures/stone.png")` reads the entry
named `textures/stone.png`, and every entry is checked against its hash before
it is used. The working directory and the asset folder play no part, so the
build that runs is the build that ships. A program without a pack (built with
`doletc` directly, or a test) reads the files under the root given to
`Assets.mount`. `AssetFiles.use_pack(path)` selects a pack explicitly.

What a name holds decides how it loads, not its extension: a cooked texture
uploads its mip chain directly, a PNG is decoded, a cooked model is parsed in
place, glTF text is read with its buffers. A model the cooker declines
(skinning, morph targets, animation) is in the pack as its source.
For 3D materials, use `TextureSpec.model_color()` for albedo/emission and
`TextureSpec.model_data()` for normal, metallic-roughness, and occlusion maps.

`obin build --force` recooks everything. Kobic Cooker remains part of the
engine package as an internal Dolet tool; there is intentionally no separate
`kobic.exe` workflow. Its only output is a one-entry `.dpk`
(`kobic-cooker <source> --out <pack.dpk> [--name <entry>]`). It exits with
code 3 for a valid source it does not cook.

`TextureSpec.with_mip_lod_bias(bias)` optionally adjusts sampled mip detail;
the default is zero and preserves existing materials. Negative values prefer
finer mip levels without disabling minification/mipmaps. Runtime sampler bias
is bounded to +/-2 and NaN falls back to zero. Applications own this art policy;
packed atlases should use zero or negative bias to retain their safe-mip limit.

`Assets.textures.load_tiled_atlas(path, spec, columns, rows, core_pixels, gutter_pixels)`
combines with `Material3D.set_world_pixel_atlas(cols, rows, padding_ratio)`.
The optional `set_world_pixel_scale(tiles_per_unit)` changes repeat density
without changing authored texels or the GPU instance ABI. It applies only to
world-projected atlas materials; ordinary mesh UV offsets are untouched.
Zero legacy encoding means one repeat/unit. Invalid input resets to one;
valid density is bounded to 0.0625..16. Both classic/bindless shaders scale
UV derivatives too, retaining correct mip selection.

The tiled-atlas loader
  loads complete editable cells and adds wrapped gutters to a separate upload image.
Its source is a PNG or a lossless RGBA8 cooked texture; a block-compressed
one cannot be padded and is refused. Packing and mip generation happen once at texture load, never
per draw. Material UV padding is `gutter_pixels/(core_pixels+2*gutter_pixels)`.
The source PNG is not cropped, resized or rewritten. Invalid dimensions fail
without an upload; the preparation buffer is limited to 64MiB.

## Philosophy

Kobic exists to make the ECS vs OOP performance / ergonomics trade-off
concrete. The companion game project `simple-game-frog-oop-3d/` is a
line-for-line port of `simple-game-kubic-ecs-3d/` so the two can be
compared fairly.
