# Texture System for Kobic Engine — Updated Plan

## ✅ حالة التنفيذ (مكتمل)

تم تنفيذ نظام الـ textures بالكامل عبر عدة ريبوهات:

- **compiler** (`f56d4fe`): إصلاح bug تهيئة الـ global initializers تحت `main()` معرّف من المستخدم.
- **image** (`3cca55e`): PNG decoder كامل (inflate + كل الفلاتر + كل color types) — `PNG.load`.
- **vulkan** (`8bdbfbe`): إضافة دوال الـ texture/descriptor للـ import lib (`vulkan-1.def`/`.lib`).
- **kobic**:
  - `c79d6a4`: vertex format صار 32 byte (pos+color+UV) + شيدرات SPIR-V جديدة (sampler2D).
  - `626d4b3`: رفع الصور للـ GPU، descriptor sets، 1×1 white fallback، والـ API العام.

### الـ API النهائي
```dolet
mesh_id: i32 = Engine.upload_model("models/x.gltf")
tex_id:  i32 = Engine.upload_texture("textures/x.png")   # يحمّل PNG ويرفعه للـ GPU
inst:    i32 = Engine.register_instance(mesh_id)
Engine.bind_texture(inst, tex_id)                        # يربط texture بالـ instance
```
الميشات بدون texture تستخدم 1×1 white fallback تلقائياً (ألوانها ما تتأثر).

> **ملاحظة**: كود الـ GPU يكمبّل ويـ link بنجاح. التحقق البصري النهائي يتم بتشغيل اللعبة.

---

## ما اكتشفناه

### مكتبة `image` الموجودة
- ✅ **الـ `Image` struct جاهز ومتكامل**: `width`, `height`, `channels=4`, `data` (RGBA raw pixels), `stride`
- ✅ **Colors و pixel ops**: `set_pixel()`, `get_pixel()`, `clear()`, `image_rgba()`, etc.
- ✅ **PNG writer** يشتغل (zlib stored blocks بدون compression)
- ❌ **`PNG.load()` = TODO stub** — يرجع `Image.empty()`
- ❌ ما في PNG decoder — لازم نبنيه من الصفر

### Vulkan Bindings الي نحتاجها — **كلها موجودة**:
| Function | موجود |
|----------|-------|
| `vkCreateImage` | ✅ |
| `vkCreateImageView` | ✅ |
| `vkCreateSampler` | ✅ |
| `vkBindImageMemory` | ✅ |
| `vkGetImageMemoryRequirements` | ✅ |
| `vkCmdPipelineBarrier` | ✅ (image layout transitions) |
| `vkCmdCopyBufferToImage` | ✅ (staging → GPU) |
| `vkCreateDescriptorSetLayout` | ✅ |
| `vkCreateDescriptorPool` | ✅ |
| `vkAllocateDescriptorSets` | ✅ |
| `vkUpdateDescriptorSets` | ✅ |
| `vkCmdBindDescriptorSets` | ✅ |
| Cleanup functions | ✅ all |

---

## الخطة النهائية

### Step 1: PNG Decoder — في مكتبة `image`

#### [NEW] `packages/image/codecs/png_decoder.dlt`

كتابة PNG decoder كامل بـ pure dolet:
1. **قراءة PNG signature** (8 bytes)
2. **Parse chunks**: IHDR → IDAT(s) → IEND
3. **IHDR**: width, height, bit depth, color type
4. **IDAT**: جمع كل الـ compressed data من كل الـ IDAT chunks
5. **Inflate (zlib decompress)**: هذا الجزء الأصعب — نبني minimal inflate:
   - Parse zlib header (2 bytes)
   - Decode deflate blocks (stored + fixed Huffman + dynamic Huffman)
   - Huffman tree building
   - LZ77 back-references
6. **Unfilter**: PNG row filters (None, Sub, Up, Average, Paeth)
7. **Output**: `Image` struct مع RGBA pixels

> [!WARNING]
> الـ Inflate decoder هو الجزء الأكبر والأصعب (~400-600 سطر). بس هو standard algorithm ونقدر نبنيه خطوة بخطوة. الـ PNG unfiltering بسيط نسبياً.

#### [MODIFY] `packages/image/codecs/png.dlt`
تعبئة `PNG.load()` ليستخدم الـ decoder الجديد.

#### [MODIFY] `packages/image/mod.dlt`
إضافة `load image/codecs/png_decoder`

---

### Step 2: إعادة استخدام `Image` struct في Kobic

#### [MODIFY] `packages/kobic/assets/types.dlt`
تحديث `Texture2D` ليحمل `Image`:
```
struct Texture2D:
    path: str = ""
    resolved_path: str = ""
    width: i32 = 0
    height: i32 = 0
    channels: i32 = 4
    gpu_id: i32 = -1      # NEW: index in renderer's texture registry
    image: Image = Image() # NEW: raw pixel data from image package
    found: i32 = 0
    ready: i32 = 0
    error: str = ""
```

#### [MODIFY] `packages/kobic/assets/assets.dlt`
تحسين `AssetTextures.load()`:
```
static fun load(path: str) -> Texture2D:
    resolved = Assets.resolve(path)
    img: Image = PNG.load(resolved)  # use image package
    if img.is_valid() == 0:
        return Texture2D(error="failed to decode PNG")
    return Texture2D(path, resolved, img.width, img.height, 4, -1, img, 1, 0, "")
```

#### [MODIFY] `packages/kobic/mod.dlt`
إضافة `import image` للـ kobic module

---

### Step 3: GPU Texture Upload

#### [NEW] `packages/kobic/render/gpu_texture.dlt`

ملف جديد يتعامل مع رفع الصور على GPU عبر Vulkan:

**A. Staging Buffer Upload:**
1. إنشاء staging VkBuffer (host visible)
2. Map + copy pixel data
3. إنشاء VkImage (R8G8B8A8_SRGB, OPTIMAL tiling)
4. تخصيص VkDeviceMemory (device local)

**B. Image Layout Transitions عبر `vkCmdPipelineBarrier`:**
1. UNDEFINED → TRANSFER_DST_OPTIMAL (قبل النسخ)
2. TRANSFER_DST_OPTIMAL → SHADER_READ_ONLY_OPTIMAL (بعد النسخ)

**C. Copy عبر `vkCmdCopyBufferToImage`:**
- نحتاج command buffer مؤقت (one-shot) من الـ command pool الموجود

**D. إنشاء VkImageView + VkSampler**

**E. Texture Registry** في `GpuRendererCore`:
```
# إضافات للـ GpuRendererCore struct:
tex_images:      i64 = 0    # VkImage[]
tex_views:       i64 = 0    # VkImageView[]
tex_samplers:    i64 = 0    # VkSampler[]
tex_memories:    i64 = 0    # VkDeviceMemory[]
tex_count:       i32 = 0
tex_capacity:    i32 = 0
mesh_textures:   i64 = 0    # mesh_id → texture_id (-1 = none)
```

---

### Step 4: Descriptor Sets

#### [MODIFY] `packages/kobic/render/gpu_render_pass.dlt`

إضافات لـ `RenderPass`:
```
# New fields:
desc_set_layout:  i64 = 0   # VkDescriptorSetLayout
desc_pool:        i64 = 0   # VkDescriptorPool
```

**تعديلات على `RenderPass.init()`:**
1. إنشاء **Descriptor Set Layout**: 1 binding = combined image sampler, fragment stage
2. إنشاء **Descriptor Pool**: يسع ~256 sets (قابل للنمو)
3. تعديل **Pipeline Layout**: إضافة الـ descriptor set layout بجانب الـ push constants الموجودة

**في `GpuRendererCore`:**
```
desc_sets:       i64 = 0    # VkDescriptorSet[] — one per texture
```

عند رفع texture جديد → `vkAllocateDescriptorSets` + `vkUpdateDescriptorSets` بالـ image view والـ sampler

---

### Step 5: Shaders جديدة

#### [MODIFY] `packages/kobic/render/gpu_shaders.dlt`

**Vertex Shader — GLSL المطلوب:**
```glsl
#version 450

// Per-vertex (binding 0, stride 32)
layout(location = 0) in vec3 inPos;
layout(location = 1) in vec3 inColor;
layout(location = 6) in vec2 inUV;          // NEW

// Per-instance (binding 1, stride 64) — same as now
layout(location = 2) in vec4 instCol0;
layout(location = 3) in vec4 instCol1;
layout(location = 4) in vec4 instCol2;
layout(location = 5) in vec4 instCol3;

// Push constant — VP matrix
layout(push_constant) uniform PC { mat4 vp; };

layout(location = 0) out vec3 fragColor;
layout(location = 1) out vec2 fragUV;       // NEW

void main() {
    mat4 mvp = mat4(instCol0, instCol1, instCol2, instCol3);
    gl_Position = mvp * vec4(inPos, 1.0);
    fragColor = inColor;
    fragUV = inUV;
}
```

**Fragment Shader — GLSL المطلوب:**
```glsl
#version 450

layout(set = 0, binding = 0) uniform sampler2D texSampler;   // NEW

layout(location = 0) in vec3 fragColor;
layout(location = 1) in vec2 fragUV;                          // NEW

layout(location = 0) out vec4 outColor;

void main() {
    vec4 texColor = texture(texSampler, fragUV);
    // إذا الـ UV = (0,0) والـ texture أبيض 1x1 → يرجع أبيض → الألوان ما تتأثر
    outColor = vec4(fragColor * texColor.rgb, texColor.a);
}
```

> [!IMPORTANT]
> لازم نعمل compile لـ GLSL → SPIR-V offline ونحوله لـ `Memory.write_i32()` calls مثل الحالي. بديل: أستخدم `glslangValidator` لتوليد الـ SPIR-V bytes ثم أكتبها hardcoded.

**White 1x1 Fallback Texture**: للـ meshes بدون texture — نسوي texture أبيض 1 pixel عشان الـ shader يشتغل uniform بدون branching.

---

### Step 6: Vertex Format + Pipeline

#### [MODIFY] `packages/kobic/render/gpu_mesh.dlt`

- `gpu_wv()` يصير stride **32 bytes**: `pos(3f) + color(3f) + uv(2f)`
- `gltf_write_position_vertex()` يقرأ UV من glTF TEXCOORD_0 accessor
- `gpu_make_cube_vertices()` / `gpu_make_plane_vertices()` يحطوا default UVs (0-1 mapping)

#### [MODIFY] `packages/kobic/render/gpu_render_pass.dlt`

Pipeline vertex input:
- Binding 0: stride **32** (بدل 24)
- Attributes: إضافة UV attr (location=6, format=R32G32_SFLOAT=103, offset=24)
- Total attributes: **7** (بدل 6)

#### [MODIFY] `packages/kobic/render/gpu_renderer_core.dlt`

- `upload_mesh()`: data_size يتغير `vertex_count * 32` (بدل 24)
- `_record_commands()`: قبل كل draw call → `vkCmdBindDescriptorSets()` بالـ texture المربوط بالـ mesh
- `_ensure_instance_capacity()`: ما يتغير (المصفوفة MVP لسا 64 bytes)

---

### Step 7: Public API — يدوي

#### [MODIFY] `packages/kobic/render/gpu.dlt`

على `Renderer`:
```
fun upload_texture(path: str) -> i32         # loads PNG, uploads to GPU, returns texture_id
fun bind_texture(mesh_id: i32, tex_id: i32)  # assigns texture to mesh
```

#### [MODIFY] `packages/kobic/core/engine.dlt`

على `Engine` (static facade):
```
static fun upload_texture(path: str) -> i32
static fun bind_texture(mesh_id: i32, texture_id: i32)
```

#### [MODIFY] `packages/kobic/core/runtime.dlt`

Passthrough functions.

---

### Step 8: Module Wiring

#### [MODIFY] `packages/kobic/mod.dlt`
```
import image                           # NEW
load kobic/render/gpu_texture           # NEW
```

#### [MODIFY] `packages/kobic/mod.dlt` exports
```
export Texture2D, GpuTexture           # types
```

---

## الاستخدام النهائي (من اللعبة)

```dolet
# تحميل model
mesh_id: i32 = Engine.upload_model("models/chicken.gltf")

# تحميل textures مختلفة
tex_red: i32 = Engine.upload_texture("textures/chicken_red.png")
tex_blue: i32 = Engine.upload_texture("textures/chicken_blue.png")

# Chicken 1 — أحمر
inst1: i32 = Engine.register_instance(mesh_id)
Engine.bind_texture(inst1, tex_red)
Engine.set_transform(inst1, 0.0, 0.0, 0.0, ...)

# Chicken 2 — أزرق
inst2: i32 = Engine.register_instance(mesh_id)
Engine.bind_texture(inst2, tex_blue)
Engine.set_transform(inst2, 5.0, 0.0, 0.0, ...)
```

---

## ترتيب التنفيذ

| # | الخطوة | ملفات | الحجم | تبعيات |
|---|--------|------|-------|--------|
| 1 | PNG Decoder (inflate + unfilter) | `image/codecs/png_decoder.dlt` [NEW] | **كبير جداً** | لا شيء |
| 2 | ربط PNG.load + Texture2D | `image/codecs/png.dlt` + `kobic/assets/*` [MODIFY] | صغير | Step 1 |
| 3 | GPU texture upload + registry | `kobic/render/gpu_texture.dlt` [NEW] | كبير | Step 2 |
| 4 | Descriptor sets | `kobic/render/gpu_render_pass.dlt` [MODIFY] | كبير | Step 3 |
| 5 | New SPIR-V shaders (UV support) | `kobic/render/gpu_shaders.dlt` [MODIFY] | كبير | — |
| 6 | Vertex format + pipeline changes | `gpu_mesh.dlt` + `gpu_render_pass.dlt` + `gpu_renderer_core.dlt` [MODIFY] | كبير | Steps 4,5 |
| 7 | Public API | `gpu.dlt` + `engine.dlt` + `runtime.dlt` [MODIFY] | صغير | Step 6 |
| 8 | Module wiring | `mod.dlt` [MODIFY] | صغير | كل شي |

## Verification Plan

### Automated
- Compile check: `doletc` بدون أخطاء
- الـ models الحالية (goblins) لازم تشتغل بالألوان الحالية (backward compatible عبر 1x1 white texture)

### Manual
- تحميل PNG texture وربطه بـ mesh ومشاهدة النتيجة
- تحميل نفس الـ model مع textures مختلفة
