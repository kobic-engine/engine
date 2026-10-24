#version 450

// Pixel-art outlines (Environment.outline), run instead of GTAO/TAA on the
// same inputs. The outer pixel of every silhouette, and of sharp creases, is
// tinted toward the outline colour, so each object keeps a darker version of
// its own hue. Reverse-Z depth of a plane is affine in screen space, so its
// Laplacian is zero across flat surfaces at any angle or distance; only real
// depth steps and folds pass the threshold, relative to the pixel's depth.

layout(location = 0) out vec4 outColor;
layout(location = 0) flat in mat4 inverseViewProjection;

layout(set = 0, binding = 0) uniform sampler2D currentColorTexture;
layout(set = 0, binding = 1) uniform sampler2D depthTexture;
layout(set = 0, binding = 2) uniform sampler2D geometryTexture;

layout(push_constant) uniform OutlinePushConstants {
    mat4 currentViewProjection;
    // x strength 0..1, y depth threshold (relative), z crease threshold
    // (1 - cos of the fold angle, 0 = off), w fade-out distance (0 = never)
    vec4 outline;
    // rgb outline colour (multiplies the surface colour), a thickness in
    // pixels (1..4; neighbours that far apart, so the band is that wide)
    vec4 color;
    vec4 reserved0;
    vec4 reserved1;
} push;

ivec2 viewportSize;

float depthAt(ivec2 pixel) {
    return texelFetch(depthTexture, clamp(pixel, ivec2(0), viewportSize - 1), 0).r;
}

vec3 normalAt(ivec2 pixel) {
    vec3 encoded = texelFetch(geometryTexture, clamp(pixel, ivec2(0), viewportSize - 1), 0).xyz;
    return normalize(encoded * 2.0 - 1.0);
}

vec3 reconstructWorld(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth, 1.0);
    vec4 world = inverseViewProjection * clip;
    return world.xyz / max(abs(world.w), 1e-6);
}

void main() {
    viewportSize = textureSize(depthTexture, 0);
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec3 color = texelFetch(currentColorTexture, pixel, 0).rgb;
    float depth = depthAt(pixel);
    float strength = clamp(push.outline.x, 0.0, 1.0);
    // Reverse-Z: the cleared sky keeps depth 0 and is never outlined.
    if (depth <= 0.00001 || strength <= 0.0) {
        outColor = vec4(color, depth);
        return;
    }

    int reach = int(clamp(floor(push.color.a + 0.5), 1.0, 4.0));
    float left = depthAt(pixel + ivec2(-reach, 0));
    float right = depthAt(pixel + ivec2(reach, 0));
    float down = depthAt(pixel + ivec2(0, -reach));
    float up = depthAt(pixel + ivec2(0, reach));
    // Negative Laplacian = this pixel stands in front of its neighbours, so
    // only the nearer side of a step gets the (one pixel wide) outline.
    float protrusion = max(2.0 * depth - left - right, 2.0 * depth - down - up) / depth;
    float threshold = max(push.outline.y, 0.0001);
    float edge = smoothstep(threshold, threshold * 1.6, protrusion);

    float creaseThreshold = push.outline.z;
    if (creaseThreshold > 0.0 && edge < 1.0) {
        vec3 normal = normalAt(pixel);
        float fold = 0.0;
        // Only neighbours at or behind this pixel, so creases stay one pixel.
        if (left <= depth) fold = max(fold, 1.0 - dot(normal, normalAt(pixel + ivec2(-reach, 0))));
        if (right <= depth) fold = max(fold, 1.0 - dot(normal, normalAt(pixel + ivec2(reach, 0))));
        if (down <= depth) fold = max(fold, 1.0 - dot(normal, normalAt(pixel + ivec2(0, -reach))));
        if (up <= depth) fold = max(fold, 1.0 - dot(normal, normalAt(pixel + ivec2(0, reach))));
        edge = max(edge, smoothstep(creaseThreshold, creaseThreshold * 1.5, fold) * 0.7);
    }

    float fadeDistance = push.outline.w;
    if (fadeDistance > 0.0 && edge > 0.0) {
        vec2 uv = (vec2(pixel) + 0.5) / vec2(viewportSize);
        float distanceToCamera = length(reconstructWorld(uv, depth) - reconstructWorld(uv, 1.0));
        edge *= 1.0 - smoothstep(fadeDistance * 0.55, fadeDistance, distanceToCamera);
    }

    outColor = vec4(mix(color, color * push.color.rgb, edge * strength), depth);
}
