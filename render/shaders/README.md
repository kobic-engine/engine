# Kobic Embedded Shaders

`textured.vert` and `textured.frag` are the source of the SPIR-V embedded in
`render/gpu_shaders.dlt`.

Regenerate the embedded shaders from the `packages/kobic` directory:

```powershell
glslangValidator -V --target-env vulkan1.0 render/shaders/textured.vert -o render/shaders/textured.vert.spv
glslangValidator -V --target-env vulkan1.0 render/shaders/textured.frag -o render/shaders/textured.frag.spv
glslangValidator -V --target-env vulkan1.0 render/shaders/shadow.vert -o render/shaders/shadow.vert.spv
glslangValidator -V --target-env vulkan1.0 render/shaders/sky.vert -o render/shaders/sky.vert.spv
glslangValidator -V --target-env vulkan1.0 render/shaders/sky.frag -o render/shaders/sky.frag.spv
glslangValidator -V --target-env vulkan1.0 render/shaders/bloom.frag -o render/shaders/bloom.frag.spv
node tools/embed_spirv.mjs render/shaders/textured.vert.spv render/shaders/textured.frag.spv render/shaders/shadow.vert.spv render/shaders/sky.vert.spv render/shaders/sky.frag.spv render/shaders/bloom.frag.spv

glslangValidator -V --target-env vulkan1.0 render/shaders/debug_collision.vert -o render/shaders/debug_collision.vert.spv
glslangValidator -V --target-env vulkan1.0 render/shaders/debug_collision.frag -o render/shaders/debug_collision.frag.spv
node tools/embed_debug_spirv.mjs render/shaders/debug_collision.vert.spv render/shaders/debug_collision.frag.spv
```

The `.spv` files are temporary build artifacts and should not be committed.

## Uniform object lighting

`Material3D.set_uniform_lighting(energy)` selects normal-independent scalar
albedo lighting (0–4). The default remains PBR/vanilla; `clear_uniform_lighting()`
restores it and `set_unlit(1)` keeps its historical full-bright behavior.
The uniform branch does not use directional/specular/sky/shadow-map shading.
Distance-attenuated point lights still add soft albedo fill, without Lambert
face bands. Texture alpha cutout, vertex colour, atlas skylight, emissive and
fog continue to work. Games own their time-of-day/lightmap energy calculation.

The existing instance/material ABI is unchanged: negative GPU metallic values
encode `-1 - energy`; ordinary materials still encode metallic in 0–1. Do not
mix different uniform energies in a static arena page (one material per page).
Both classic and bindless fragment shaders implement the same branch.
