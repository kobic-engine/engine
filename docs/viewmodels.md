# Camera-relative viewmodels

Opt in per material with `Material3D.set_viewmodel(1)`, then bind it normally.
Attach its model matrix to the active camera in your game. Projection retains
the camera's FOV/aspect while giving the mesh a 2 cm near clip and a foreground
depth band (0..0.0001). Self-occlusion is retained. Scene camera near/far planes
are not modified: distant-world depth precision is unaffected.

The option works on classic, bindless and bindless-SSBO textured/skinned paths.
CPU and dynamic GPU culling preserve foreground instances instead of testing
their geometry against the world near plane. Material binding disables static
batching and cast/receive shadows for that instance. Visibility is still an
explicit caller-controlled property. Shared geometry does not share this flag.

GPU material ABI remains unchanged: negative emission encoding tags viewmodels;
vertex shaders restore the nonnegative emission before fragment shading. Texture,
cutout, uniform lighting, UV and emissive-map flags retain their existing meaning.
Viewmodel fog distance is zero. This is a foreground projection option, not a
second camera/render-pass system. Depth-based post effects may need game-specific
configuration (Bitora disables them). Opaque/cutout is recommended.

When an item becomes a world object, rebind with `set_viewmodel(0)`. Restore static
batching and shadow policy explicitly if wanted; this API does not silently infer
or restore those policies. Custom shaders must implement their own projection.

Regression fixture in the Bitora integration suite: `player_hands_prone_checks`.
It renders real skins with a 10 m world near clip, verifies instance isolation,
CPU culling and untouched camera range, and has a genuine classic-renderer mode.
