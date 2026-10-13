# Kobic Renderer Facade Notes

This file tracks the renderer API problems that blocked hiding the low-level
Vulkan objects behind a clean high-level Kobic API.

## Current Stable Shape

The public game-facing API is now `Engine`:

```dolet
Engine.window.create("Kobic Game", 1280, 720)
Engine.properties.set_vsync(1)
Engine.scene.set(scene)
if Engine.start() == 1:
    mesh: i32 = Engine.upload_cube_mesh()
    Engine.render()
    Engine.shutdown()
```

`Engine` owns the game-facing lifecycle through a single static runtime.
Public configuration is grouped under namespaces such as `Engine.window`,
`Engine.properties`, and `Engine.scene`. Internally it stores `EngineRuntime`,
which owns the window, Vulkan context, swapchain, render pass, and renderer.
`Renderer` wraps `GpuRendererCore`. Regular gameplay code should use `Engine`;
the lower-level types remain runtime/backend plumbing.

The framework runtime owns these lower-level Vulkan objects directly:

- `GpuRendererCore`
- `VulkanContext`
- `Swapchain`
- `RenderPass`

They should stay in Kobic package runtime / renderer plumbing only. Regular
gameplay code should not call lower-level types or raw helpers such as
`gpu_set_transform`.

## What We Tried

### 1. `Renderer3D` wrapper struct

Goal:

```dolet
renderer: Renderer3D = Renderer3D.create(app)
mesh: Mesh = renderer.load_model("assets/player.gltf")
renderer.render(scene, camera)
```

Result:

- Originally crashed after Vulkan initialization or during swapchain setup.
- Fixed after compiler changes for nested struct copy/access.
- Current narrow facade wraps `GpuRendererCore` only. It is stable in the
  Kobic sample smoke test.

### 2. Package-level `Graphics3D` globals

Goal:

```dolet
Graphics3D.init(app)
mesh: Mesh = Graphics3D.load_model("assets/player.gltf")
Graphics3D.render(camera)
```

Result:

- The program crashed in or around `Swapchain.init`.
- Moving complex renderer state into package globals appeared to corrupt
  fields such as `initialized` and `vb_capacity`.

### 3. Type aliases for cleaner names

Goal:

```dolet
type Renderer = GpuRendererCore

renderer: Renderer = Renderer()
renderer.upload_plane_mesh()
```

Result:

- Originally failed because method lookup tried `Renderer_upload_plane_mesh`
  instead of resolving the alias back to `GpuRendererCore_upload_plane_mesh`.
- Fixed by normalizing aliases before static/instance method dispatch.

## Fixed Compiler Gaps

These were fixed before enabling the facade:

1. Type aliases now normalize before method lookup and overload resolution.

2. Struct assignment / return / global storage for nested structs now deep-copy
   stack-struct fields into stable storage.

3. Nested field/method access now has a consistent pointer contract: field
   pointer helpers return the slot address, and callers load struct pointers
   only when they need the value.

## Remaining Design Work

0. `Engine.properties.set_render_scale(scale)` now uses the professional path:
   render into an offscreen color/depth target sized from the scale, then blit
   into the swapchain image for presentation. The direct swapchain render path
   remains active when scale resolves to native size.

0. `Engine.properties.set_gpu_preference(pref)` selects the Vulkan physical
   device before runtime startup. The public API only exposes
   `GpuPreference.auto()` and `GpuPreference.index(n)` so selection stays
   vendor-neutral and based on the 0-based Vulkan device index.

1. A stable owning-handle pattern is still needed for engine objects that wrap native
   resources. Either:
   - heap-own the state and pass a pointer-like wrapper, or
   - make struct copy semantics explicit enough to prevent accidental resource
     duplication.

2. Package-level global mutable state with complex structs needs tests. It
   should not corrupt nested fields after init, method calls, or assignment.

3. Add more focused compiler tests for:
   - alias overload dispatch
   - instance-method overload dispatch when arity differs (`foo()` vs `foo(i32)`)
   - package-level complex globals
   - explicit move/no-copy ownership patterns for native resources

## Future Target API

Longer term, the renderer API should become:

```dolet
Engine.window.create("Kobic Game", 1280, 720)
scene: Scene = Scene.create()
camera: Camera3D = Camera3D.create("camera")

renderer: Renderer3D = Renderer3D.create()
model: Model = renderer.load_model("assets/character.gltf")

player: Node3D = Node3D.create("player")
player.set_model(model)
scene.add_child(player)

while Engine.running():
    dt: f32 = Engine.begin_frame()
    scene.update(dt)
    renderer.render(scene, camera)

renderer.destroy()
Engine.shutdown()
```

Until then, keep the Vulkan context/swapchain/render pass in the Kobic package
runtime only and expose small safe methods on `Engine` as needed.
