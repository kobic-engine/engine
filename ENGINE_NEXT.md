# Kobic Engine - Next Engine Work

This file tracks the engine-level systems that should live in Kobic rather than
inside a single game project.

## Priority Order

1. **Profiler / diagnostics**
   - CPU update time, render time, GPU wait, draw calls, visible instances,
     upload counts, texture memory, and frame-time spikes.
   - Target API:
     ```dolet
     Engine.debug.profiler(1)
     Engine.debug.render_stats(1)
     Engine.debug.gpu_stats(1)
     ```

2. **Display / monitor / GPU info**
   - Needed for multi-GPU debugging, monitor selection, resize/fullscreen
     issues, and NVIDIA-vs-Intel device checks.
   - Target API:
     ```dolet
     Engine.display.monitor_count()
     Engine.display.gpu_count()
     Engine.display.gpu_name(0)
     Engine.window.set_monitor(0)
     ```

3. **Materials**
   - Move beyond direct texture binding and give nodes a reusable material.
   - Target API:
     ```dolet
     mat: Material = Material.create()
     mat.set_albedo(Assets.textures.load("textures/actor.png", TextureSpec.pixel()))
     mat.set_roughness(1.0)
     node.set_material(mat)
     ```

4. **Lighting**
   - Scene/environment ambient light plus reusable light nodes.
   - Target API:
     ```dolet
     env.set_ambient(Color.rgb(0.45, 0.50, 0.55))
     sun: DirectionalLight3D = DirectionalLight3D.create("Sun")
     sun.set_energy(1.8)
     scene.add_child(sun)
     ```

5. **Input actions**
   - Game code should bind gameplay actions instead of polling raw keys
     everywhere.
   - Target API:
     ```dolet
     InputMap.bind("move_forward", KEY_W)
     InputMap.bind("sprint", KEY_SHIFT)
     if Input.action_down("move_forward") == 1:
         ...
     ```

6. **Asset cache**
   - Repeated model/texture loads should return existing resources rather than
     decoding/uploading duplicates.
   - Target API:
     ```dolet
     Assets.cache.enable(1)
     model: Model3D = Assets.models.load("models/player.gltf")
     ```

7. **Raycast / collision helpers** - initial pass done
   - General scene helpers for picking, shooting, interaction, and simple box
     collisions. Voxel-specific terrain collision stays in the game project.
   - Current API:
     ```dolet
     raycast: Raycast3D = Raycast3D.create("InteractRay")
     raycast.set_max_distance(8.0)
     camera.add_child(raycast)

     if raycast.is_colliding() == 1:
         node: Node3D = raycast.collider()
     ```
   - Current scope: `Node3D` box colliders, reusable `Raycast3D` nodes,
     scene raycasts, and camera-ray convenience helpers.
   - Still future work: swept collision, rigid bodies, layers/masks, and
     game-specific terrain adapters.

8. **Audio playback**
   - `Assets.audio.load` exists as a descriptor path; runtime playback is still
     needed.
   - Target API:
     ```dolet
     clip: AudioClip = Assets.audio.load("sounds/fire.wav")
     Audio.play(clip)
     ```
