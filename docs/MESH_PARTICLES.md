# MeshParticles3D

An opt-in OOP pool for lightweight 3D debris. Create once per effect owner;
attach a source mesh before emitting. Instances borrow its geometry, avoiding
mesh uploads and allocation per emission. Maximum capacity is 512 per pool.
Headless pools work without a mesh; attaching a mesh limits availability to
successfully registered instances. The hidden source and instances live in
the engine registry until engine shutdown: do not repeatedly recreate rendered
pools during a session.

`emit(ParticleBody3D, size, lifetime)` returns a slot or -1. A positive lifetime
expires cosmetic particles; zero lifetime persists until explicit `release`.
Overflow refuses emission and never replaces a persistent particle. Release is
idempotent. `render_tag` is an optional application-owned material revision,
reset to -1 on reuse.

Each frame:

1. Call `begin_frame(dt)`.
2. While `advance_step(gravity)` returns 1, inspect active slots with
   `contact_due != 0` and submit `resolve_contact(index, result)`.
3. Use `render_position(index)` and `draw_slot(index, world_frame, visible)`.

The supplied world frame already includes translation. Draw adds body rotation
and uniform size. Bodies and collision radii use application world units;
angles and angular velocities use degrees and degrees/second.

`ParticleContact3D.status` is 0 for clear, 1 for contact (resolved body **centre**
plus outward normal), or 2 for unavailable world. Awake bodies roll back their
entire step on unavailable data and retry after 0.25 seconds. Sleeping bodies
check support approximately four times/second; clear support wakes them. The
application must sweep previous/current centres, sample support for sleepers,
and implement its own streaming policy, world frame and visibility.

Simulation uses 120 Hz with at most eight steps/frame and clamps accumulated
frame time to 1/15 second per submitted frame. Large stalls intentionally slow
debris rather than running unbounded catch-up. Restitution/friction are bounded;
quiet contacts sleep after 0.18 seconds. A low-speed contact with less than
0.04 m/s of resolved
translation also sleeps after 0.25 seconds (constrained multi-face support).
Draw interpolates positions and shrinks timed particles during their final
0.12 seconds, without transparent sorting.

This is **not** a rigid-body solver: no mesh contact manifold, stacking,
particle-particle collision, networking, inventory, saving or SDF dependency.
The caller owns successful emission transactions and must reserve capacity
before performing an irreversible resource-producing edit. Destroy releases
CPU storage and hides borrowed GPU instances; free the heap owner separately.

Regression: compile and run `tests/mesh_particles_checks.dlt`. It covers bounded
reuse, timed/persistent lifetimes, contact sleep/wake, missing-world freeze,
idempotent release and fixed-step travel at 30/60/120/240 Hz.
