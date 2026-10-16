#version 450

layout(location = 0) out float outAo;
layout(location = 0) flat in mat4 inverseViewProjection;

layout(set = 0, binding = 0) uniform sampler2D depthTexture;
layout(set = 0, binding = 1) uniform sampler2D geometryTexture;

layout(push_constant) uniform GtaoPushConstants {
    mat4 viewProjection;
} gtao;

vec3 reconstructWorld(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth, 1.0);
    vec4 world = inverseViewProjection * clip;
    return world.xyz / max(abs(world.w), 1e-6);
}

float interleavedGradientNoise(vec2 pixel) {
    return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

void main() {
    ivec2 outputSize = textureSize(depthTexture, 0) / 2;
    vec2 uv = (gl_FragCoord.xy * 2.0) / vec2(textureSize(depthTexture, 0));
    float centerDepth = texture(depthTexture, uv).r;
    // Reverse-Z: the cleared sky keeps depth 0.
    if (centerDepth <= 0.00001) {
        outAo = 1.0;
        return;
    }

    vec3 center = reconstructWorld(uv, centerDepth);
    vec3 normal = normalize(texture(geometryTexture, uv).xyz * 2.0 - 1.0);
    vec2 texel = 1.0 / vec2(textureSize(depthTexture, 0));
    float rotation = interleavedGradientNoise(gl_FragCoord.xy) * 6.28318530718;
    float radiusPixels = clamp(7.0 + (1.0 - centerDepth) * 13.0, 7.0, 20.0);

    // Four horizon slices, sampled in both directions. Each slice keeps the
    // maximum visible horizon instead of averaging arbitrary depth taps; this
    // is the defining GTAO behaviour and remains stable at half resolution.
    float visibility = 0.0;
    const int directionCount = 4;
    const int stepCount = 3;
    for (int directionIndex = 0; directionIndex < directionCount; ++directionIndex) {
        float angle = rotation + (float(directionIndex) + 0.5) * 1.57079632679;
        vec2 direction = vec2(cos(angle), sin(angle));
        float positiveHorizon = 0.0;
        float negativeHorizon = 0.0;
        for (int stepIndex = 1; stepIndex <= stepCount; ++stepIndex) {
            float stepFraction = float(stepIndex) / float(stepCount);
            vec2 offset = direction * texel * radiusPixels * stepFraction;
            for (int side = 0; side < 2; ++side) {
                vec2 sampleUv = uv + offset * (side == 0 ? 1.0 : -1.0);
                if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) {
                    continue;
                }
                float sampleDepth = texture(depthTexture, sampleUv).r;
                if (sampleDepth <= 0.00001) {
                    continue;
                }
                vec3 delta = reconstructWorld(sampleUv, sampleDepth) - center;
                float distanceToSample = length(delta);
                if (distanceToSample <= 1e-4) {
                    continue;
                }
                float rangeWeight = 1.0 - smoothstep(0.35, 4.5, distanceToSample);
                float horizon = max(dot(normal, delta / distanceToSample) - 0.055, 0.0) * rangeWeight;
                if (side == 0) {
                    positiveHorizon = max(positiveHorizon, horizon);
                } else {
                    negativeHorizon = max(negativeHorizon, horizon);
                }
            }
        }
        visibility += 1.0 - clamp((positiveHorizon + negativeHorizon) * 0.72, 0.0, 1.0);
    }

    float ao = visibility / float(directionCount);
    // Preserve contact strength without crushing broad cave illumination.
    outAo = clamp(pow(ao, 1.35), 0.10, 1.0);
}
