# ⚙️ Kobic Engine Core

**Kobic** is a modular, high-performance 3D game engine architecture built from the ground up using the **Dolet Programming Language**. Engineered for maximum efficiency, it combines a modern Vulkan-based rendering pipeline with a robust Data-Oriented ECS framework.

---

## 💎 Engine Architecture & Modules

By the grace of Allah, the engine is structured into specialized modules to ensure scalability and raw performance:

### 🎮 Core & ECS Framework
- **ECS (Entity Component System)**: Optimized `component_storage` and high-speed `query` systems for cache-friendly execution.
- **Scene Tree**: Hierarchical management via `scene_tree` and `node3d` for intuitive world organization.
- **App Lifecycle**: Centralized `kobic_main` and `app` logic for seamless state management.

### 🖼️ Render Pipeline (Vulkan)
- **Vulkan Context**: Low-level `vulkan_context` and `swapchain` management for near-metal GPU control.
- **Renderer**: Advanced `render_pass` and `renderer` logic with support for `embedded_shaders`.
- **Mesh System**: Built-in primitives including `cube`, `plane`, and `sphere` meshes.

### 📐 Physics & Math Library
- **Linear Algebra**: Comprehensive math suite featuring `mat4`, `quat` (Quaternions), `vec3`, and `color` utilities.
- **Physics World**: Dedicated `physics_world` with `collision_shape3d` and `rigid_body3d` support.

### ⌨️ Input & UI
- **Input System**: Unified handling for `mouse` and `key_code` events.
- **Native UI**: Built-in HUD components including `label` and `crosshair` systems.

---

## 🛠️ Project Directory Structure

```text
Kobic/
├── core/         # Application & Scene management
├── ecs/          # Entity Component System core
├── render/       # Vulkan-based rendering pipeline
├── math/         # Linear algebra & Math utilities
├── mesh/         # 3D Mesh & Geometry definitions
├── node3d/       # Camera, Lights, and 3D Nodes
├── physics/      # Collision & Physics engine
├── input/        # Mouse & Keyboard handling
├── ui/           # HUD & UI components
└── shaders/      # Shader management