# Reverse-Z main depth

The main camera uses reverse-Z. `gpu_camera_proj_into_range` maps the near
plane to depth 1 and the far plane to 0. The main D32_SFLOAT depth buffer is
cleared to 0, and every main-pass pipeline tests GREATER.
`KOBIC_MAIN_DEPTH_COMPARE` and `KOBIC_MAIN_DEPTH_CLEAR` live in
`render/gpu_vertex_layout.dlt`.

## Why

A float depth buffer is most precise near 0. With standard depth, 0 is the
near plane, so the depth step at distance `d` grows like `d^2 / (near * 2^24)`.

Bitora's third-person camera has a 0.15 m near plane and a 50,968 km far
plane. With standard depth, the step was about 4 km at 100 km and hundreds of
km at 1000 km. Seen from space, the 2 km cloud shell and the ground therefore
fought over the same depth and flickered.

Reverse-Z puts 0 at the far plane, where the float exponent keeps its
precision. The error is then about 1e-7 of the distance, roughly 0.1 m at
1000 km. `tests/frustum_cull_checks.dlt` shows this directly: two points 2 km
apart at 1000 km get the same depth with the old projection and distinct
depths with the new one.

## What changed

- **Projection:** `m10 = near / (far - near)` and `m14 = near * far / (far - near)`.
- **Depth state:** the main pass clears to 0. The classic, bindless and SSBO
  opaque and transparent pipelines, and the debug pipeline, compare GREATER.
- **Viewmodels:** the foreground band is now `[1 - 1e-4, 1]`, computed as
  `clip.z = w - 1e-4 * (w - 0.02)`. Anything with `w < 0.02` is clipped.
- **HZB:**
  - The depth pyramid keeps the farthest depth, which is now the smallest
    (`min`, starting at 1).
  - The cull shader takes a sphere's nearest corner as the largest depth.
  - The sphere is occluded when that depth is below the pyramid's farthest
    occluder minus the bias.
  - The bias has the same meaning in metres in both conventions.
- **GTAO and TAA:** a depth at or below 1e-5 is sky. The GTAO radius uses
  `1 - depth`. The TAA depth-agreement thresholds keep their meaning, because
  `|delta depth|` has the same size in both conventions.
- **Frustum planes:**
  - Near and far are now `z >= 0` (row2) and `z <= w` (row3 - row2), in
    `kobic_cull_extract_planes` and `_kobic_instance_visible`.
  - These two planes are correct in both conventions for [0,1] clip depth.
  - The old OpenGL-style near plane (`z >= -w`) culled nothing under reverse-Z.
  - The standard-depth shadow cascades share the extraction.

## Unchanged

- **Shadow maps:** their own image and pass, clear 1, LESS, and a LESS_OR_EQUAL
  comparison sampler.
- **Passes without a depth test:** sky, celestial objects, bloom and the
  temporal passes.
- **Viewports:** still 0..1.
- **`Mat4.perspective`:** not in the render path; the tests use it as the
  standard-depth reference.

## Shaders

The changed sources were compiled and embedded with `tools/regen_shader.py`:

- `textured.vert`, `textured_bindless.vert`, `textured_bindless_ssbo.vert`,
  `cull.comp` and `hzb.comp` with `glslangValidator -V --target-env vulkan1.0`.
- `gtao.frag` and `taa_gtao.frag` with the same command plus `-Os`.

Before any edit, the unmodified sources reproduced the previously embedded
SPIR-V byte for byte with exactly these flags.

## Verified

- `frustum_cull_checks`, `static_move_checks` and `sky_fog_checks` pass.
- Bitora screenshots of all nine benchmark phases match the previous build;
  only animated mobs, grass and drifting clouds differ.
- The late-occlusion (HZB) counts and GPU time are unchanged.
- `player_hands_prone_checks` passes on the GPU-driven and classic paths.
