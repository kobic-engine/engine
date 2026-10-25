# Sound in Kobic

Kobic connects scene geometry and nodes to sound. Everything that shapes
the sound itself (panning, the binaural head model, reverb, mixing) lives
in the `audio3d` package. The engine owns:

- one `AudioMixer`;
- one `Speaker`;
- one `AudioScene`, on mixer bus 1.

## Start

```dolet
Engine.audio.set_output(AUDIO3D_OUTPUT_BINAURAL)   # before Engine.start; stereo by default
Engine.start()                                     # opens the default device
```

- **No device.** Kobic prints the reason once and keeps the scene running in
  silence. Sound never stops the game.
- **No audio at all.** `Engine.audio.set_enabled(0)`, called before
  `Engine.start`, starts no mixer and no audio thread.
- **Tests and tools.** `Engine.audio.start_offline(rate)` builds the scene
  without a device. Render it with `Engine.audio.scene().render_buffer(frames)`.

## Each frame

`Engine.render` does the audio work after game logic and the camera, before
drawing:

1. **Listener.** The camera becomes the listener, with the same eye, forward
   and up as the view matrix.
2. **Sources.** Every `AudioSource3D` and every one-shot moves to its node's
   position.
3. **Occlusion.** The engine casts the occlusion rays.
4. **Areas.** The engine places the reverb areas.
5. **Update.** It calls `scene.update(dt)` once.

Audio is relative to the camera:

- The listener stays at the origin, and every position is world minus eye.
  So f32 keeps its precision even 800 km from the origin.
- Convert your own positions with `Engine.audio.local_x/y/z`.
- Call `Engine.audio.camera_cut()` on cuts, respawns and teleports, so the
  jump does not make a Doppler sweep.

## Sounds

```dolet
step: AudioClip = Assets.audio.load("sfx/step.wav")      # decoded once, cached by path
engine: AudioSource3D = AudioSource3D.create(Assets.audio.load("sfx/engine.wav"), AudioEmitter(looping=true, group=KOBIC_AUDIO_VEHICLES))
engine.follow(car_node)                                   # or place it like any Node3D
Engine.audio.play_at(step, x, y, z, AudioEmitter())       # fire and forget, stays at (x, y, z)

steps: i32 = Assets.audio.sound(AudioEmitter(max_distance=30.0))
Assets.audio.sound_add(steps, "sfx/grass_step_1.wav")
Assets.audio.sound_add(steps, "sfx/grass_step_2.wav")
Assets.audio.sound_variation(steps, 2.0, 1.5)
Assets.audio.sound_limit(steps, 4, AUDIO3D_STEAL_OLDEST, 0.0)
Engine.audio.play_sound(steps, foot_x, foot_y, foot_z)
```

- **Destroying a source.** Destroy the node, either alone or with its
  parent's tree, and its emitter is released:
  - a looping sound stops;
  - a one-shot finishes.
- **Direction.** A source with a cone points along its node's forward.

## Occlusion

Each heard emitter gets 5 rays from `Engine.scene.raycast`:

- one from the listener to the emitter;
- four parallel to it, offset 0.3 m.

What the rays decide:

| Rays blocked | Result |
|---|---|
| all 5 | occlusion 0.9 (a wall) |
| some | obstruction = the blocked fraction (a pillar) |

Rays the engine skips:

- emitters that are not heard (virtual or inaudible) cost no rays;
- hits on the emitter's own node, on the node it follows, and on the
  listener's body (`Engine.audio.set_listener_body(player)`) do not block.

The ray budget is 48 rays per frame, shared round-robin between emitters.
Change it with `Engine.audio.set_ray_budget`.

## Reverb areas

```dolet
cave: AudioArea3D = AudioArea3D.box(AudioEnvironment.cave(), 6.0, 4.0, 6.0, 3.0, 1)   # half extents, fade, priority
room: AudioArea3D = AudioArea3D.sphere(AudioEnvironment.room(), 3.0, 1.0, 2)
Engine.audio.set_environment(AudioEnvironment.forest())   # outside every area (outdoor by default)
```

Areas blend from the lowest priority to the highest around the listener.

## Groups and the mix

| Group | Constant |
|---|---|
| sfx | `KOBIC_AUDIO_SFX` (0) |
| music | `KOBIC_AUDIO_MUSIC` (1) |
| voice | `KOBIC_AUDIO_VOICE` (2) |
| ui | `KOBIC_AUDIO_UI` (3) |
| ambience | `KOBIC_AUDIO_AMBIENCE` (4) |
| vehicles | `KOBIC_AUDIO_VEHICLES` (5) |

- **Settings.** `Engine.audio.set_master_volume(v)` and
  `set_group_volume(group, v)`.
- **Pause.** `Engine.pause()` / `Engine.resume()`:
  - sfx and vehicles pause in place;
  - music and ambience drop 6 dB behind a low-pass.
- **Under water.** `Engine.audio.set_underwater(1)`:
  - the world groups are muffled;
  - the environment becomes the underwater preset.
- **Ducking.** The voice group lowers the music by 9 dB.
- **HDR.** `Engine.audio.set_hdr(1)`. Set each emitter's `loudness_db`.

Volumes and states compose. Pausing never loses the player's volume settings.

## Cost

Measured at `-O2`:

| Scene | Game thread | Audio thread |
|---|---|---|
| 200 sources (64 real, 137 virtual voices), binaural, 45 rays per frame | 31 µs per frame | 9.1 % of one core |

`kobic_log` reports every 600 frames:

- real voices;
- virtual voices;
- rays used.

## Tests

The tests run without a device:

| Test | What it checks |
|---|---|
| `audio_engine_checks` | the engine scene starts and stops |
| `audio_listener_checks` | turning, 800 km from the origin |
| `audio_source_checks` | following, release on destroy, one-shots |
| `audio_asset_checks` | WAV loading, cache, sound sets |
| `audio_occlusion_checks` | wall, pillar, ray budget |
| `audio_area_checks` | reverb areas |
| `audio_mix_checks` | pause, ducking, volumes, under water |

`audio_demo_scene` is not a check: it records 10 s of binaural audio and
measures the cost.
