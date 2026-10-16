# Opt-in directional sky and matching distance fog

`Sky.set_gradient_curve(power)` controls the horizon-to-zenith curve, clamped
to0.2..4. The default1.0 retains the original linear gradient.
`Sky.set_horizon_glow(direction:Vec3, color:Color, strength, extent)` adds a
world-directional glow around the local horizon. Direction is normalized,
strength is clamped to0..1 and vertical extent to0.05..1. A zero direction
disables it safely; `clear_horizon_glow()` clears it explicitly. Default
strength0 leaves existing projects unchanged. The engine has no planet or
time-of-day policy: applications supply the local up vector and authored colour.

`Fog.sky(fallback:Color, start_distance, end_distance, strength)` is explicit
mode5, using spherical distance and a smoothstep range times0..1 strength.
After that blend, surfaces converge to the direction-evaluated sky colour,
including the same curve, local up and horizon glow as the background.
Without an enabled sky the supplied fallback colour is used. Other fog
constructors/modes keep their prior behavior. Clear foreground pixels skip
the extra directional evaluation when the fog factor is zero.

The existing lighting UBO's336-byte prefix is unchanged; three vec4 values
at336,352,368 extend it to384bytes. Sky data is available even if indirect
lighting is disabled. The base sky draw reuses its existing128-byte push
constants; celestial-object and cloud modes retain their separate packing.
No new texture, fullscreen fog pass or per-draw allocation is introduced.

## Per-mesh fog distance

`Engine.set_mesh_fog_distance_scale(mesh_id, scale)` divides the fog distance
of one mesh by `scale` (bindless pipeline). A cloud deck kilometres away can
then fade over kilometres while the ground keeps its short haze: Bitora's
cloud deck uses 25 with a 640 m sky fog, so it reaches the sky colour near
16 km instead of 640 m. 1, 0 or a negative value restores the default. The
scale rides in the instance record's texIndex1.z (float bits, 0 = default),
which was always written as 0, so no record grows and other meshes are
unchanged. Changing it marks only that mesh dirty.

## Regeneration and checks

```powershell
python tools/prepare_sky_fog_shaders.py
python tools/prepare_sky_fog_shaders.py --check-only
python tests/test_sky_fog_contract.py
../../bin/doletc.exe tests/sky_fog_checks.dlt -o .build/sky-fog/sky_fog_checks.exe
./.build/sky-fog/sky_fog_checks.exe
```

The preparation script compiles only sky.frag, textured.frag and
textured_bindless.frag, validates each with spirv-val, then atomically updates
their marked blocks in gpu_shaders.dlt. Other embedded bytes are preserved.
A recoverable previous embedding and hash manifest are stored under.build/sky-fog.
It discovers the Vulkan SDK tools from PATH/VULKAN_SDK, or accepts explicit
`--glslang-validator` and `--spirv-val` paths. It does not compile a game or
the Dolet compiler. Source-only GLSL edits do not update the embedded runtime
until this preparation runs.

The native headless fixture checks real API bounds and CPU packing, including
no-sky/no-lighting behavior and rotated local-up frames. The Python suite
checks exact shader-helper parity,2000 random local-frame comparisons,
original defaults, smooth fog and compiled SPIR-V UBO member offsets.
Both suites and the three shader builds were verified on Windows. Bitora's
separate bounded GPU fixture checks actual day/sunset/opposite/night captures.
