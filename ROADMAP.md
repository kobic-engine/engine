# Kobic Engine - Roadmap

Kobic is a 100% OOP game engine written in Dolet. It shares NO code with Kobic.
Only common low-level dependencies (Vulkan bindings, Win32 window bindings)
are reused via their standalone packages, the same way any independent engine
would depend on them.

## Design Principles

1. Every renderable / interactive thing is a `GameObject` subclass.
2. State lives in object fields, not component storages.
3. Behavior lives in virtual methods (via function-pointer dispatch when needed).
4. No queries, no component strings, no offset math in user code.
5. Scene owns a tree of objects; update = traverse tree.

## Dependencies

- `window` package  (Win32 window, keyboard, vulkan surface) - external, OS-level
- `input`  package  (mouse + keyboard state helpers) - external, OS-level
- `vulkan` package  (Vulkan C API bindings) - external, graphics-level

No dependency on `kobic/*`.

## Phases

### Phase 0  - Setup                                    [DONE]
- [x] Directory structure
- [x] Roadmap document
- [x] mod.dlt manifest
- [x] kobic.dlt hub
- [x] module.meta

### Phase 1  - Math library                             [DONE]
- Vec2, Vec3, Vec4
- Mat4 (world/view/projection matrices)
- Quat (rotations)
- Color
- Math utilities: lerp, clamp, deg2rad, rad2deg, fast trig helpers

### Phase 2  - Window + App shell                       [IN PROGRESS]
- [x] AppWindow over the unified window package
- [x] Clock / high-resolution time
- [x] App shell
- [x] Minimal keyboard OOP wrapper
- [ ] Mouse OOP wrapper
- [ ] Event helpers

### Phase 2.5 - OOP scene benchmark                     [IN PROGRESS]
- [x] Scene packed object storage
- [x] GameObject OOP handle API
- [x] ObjectBench update throughput test
- [x] Tiny software-rendered player demo
- [ ] Kobic-vs-Kobic benchmark notes

### Phase 3  - Vulkan layer                             [PLANNED]
Low-level Vulkan wrappers written from scratch:
- VulkanContext (instance, device, surface, queues)
- Swapchain (images, image views, depth buffer)
- RenderPass (attachments, subpasses, framebuffers, pipeline)
- Shader module loading from embedded SPIR-V bytecode

### Phase 4  - Renderer + Mesh                          [PLANNED]
- class Mesh      (vertex + index GPU buffers)
- class CubeMesh, PlaneMesh, SphereMesh (built-ins)
- class Renderer  (uploads per-object model matrices, draws objects)
- Instance rendering path for 20k+ objects

### Phase 5  - Scene + GameObject                       [PLANNED]
- class GameObject       (pos, rot, scale, optional parent/children, update/draw hooks)
- class MeshObject       (GameObject + Mesh reference)
- class Camera           (GameObject + view/projection matrix builder)
- class Scene            (root list of game objects, update/render driver)

### Phase 6  - End-to-end proof                         [PLANNED]
- main.dlt that opens a window and renders a spinning cube on a plane
- Verify 60+ FPS, no leaks, clean shutdown

### Phase 7  - Port game - Flycam + Earth + Goblin      [PLANNED]
First pass of the real game:
- Flycam: Camera subclass with WASD + mouse-look
- Earth:  spawns ground plane + spawns goblins
- Goblin: MeshObject subclass with AI fields (home, dir, phase, timer, group_id...)
- GoblinManager: holds `list<Goblin>` or packed `array<Goblin>`, update_all(dt)

### Phase 8  - Port Critter + Player                    [PLANNED]
Bring the rest of the game to feature parity with the Kobic version.

### Phase 9  - Performance tuning                       [PLANNED]
- Profile 20 000 goblins
- Batch per-frame GPU uploads
- Measure honest OOP-vs-ECS difference and record numbers in README

## Non-goals (for now)

- Physics (simple_game does not use it)
- Audio
- Networking
- Hot reload
- Editor UI

## File Layout (planned)

```
packages/kobic/
  mod.dlt            # module manifest + exports
  kobic.dlt           # umbrella import hub
  module.meta
  README.md
  ROADMAP.md         # <-- you are here
  core/
    engine.dlt       # lifecycle: init, frame loop, cleanup
    time.dlt
    window.dlt
    input.dlt
  math/
    vec3.dlt
    mat4.dlt
    quat.dlt
    color.dlt
    math_utils.dlt
  vulkan_layer/
    vulkan_context.dlt
    swapchain.dlt
    render_pass.dlt
    shader_module.dlt
  mesh/
    mesh.dlt
    cube_mesh.dlt
    plane_mesh.dlt
    sphere_mesh.dlt
  render/
    renderer.dlt
  scene/
    game_object.dlt
    mesh_object.dlt
    camera.dlt
    scene.dlt
  shaders/
    embedded_shaders.dlt
```

## Test / Demo project layout (planned)

```
simple-game-frog-oop-3d/
  src/
    main.dlt
    world/
      earth.dlt
    mobs/
      player/
        player.dlt
        controller.dlt
      goblin/
        goblin.dlt
        manager.dlt
      critter/
        critter.dlt
        manager.dlt
  build.bat
  README.md
```

## Session Plan (honest estimate)

| Session | Phases | Hours |
|---------|--------|-------|
| 1 (now) | 0 + 1            | ~1.5  |
| 2       | 2 + 3 partial    | ~3    |
| 3       | 3 finish + 4     | ~3    |
| 4       | 5 + 6            | ~2    |
| 5       | 7                | ~2    |
| 6       | 8 + 9            | ~2    |
| **Total** |                | **~13-15 hours** |
