#version 450

layout(location = 0) out vec4 outHistory;
layout(location = 0) flat in mat4 inverseViewProjection;

layout(set = 0, binding = 0) uniform sampler2D currentColorTexture;
layout(set = 0, binding = 1) uniform sampler2D depthTexture;
layout(set = 0, binding = 2) uniform sampler2D geometryTexture;
layout(set = 0, binding = 3) uniform sampler2D gtaoTexture;
layout(set = 0, binding = 4) uniform sampler2D previousHistoryTexture;

layout(push_constant) uniform TemporalPushConstants {
    mat4 currentViewProjection;
    mat4 previousViewProjection;
} temporal;

vec3 reconstructWorld(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth, 1.0);
    vec4 world = inverseViewProjection * clip;
    return world.xyz / max(abs(world.w), 1e-6);
}

vec3 rgbToYCoCg(vec3 color) {
    float y = dot(color, vec3(0.25, 0.5, 0.25));
    float co = color.r - color.b;
    float cg = color.g - 0.5 * (color.r + color.b);
    return vec3(y, co, cg);
}

vec3 yCoCgToRgb(vec3 color) {
    float t = color.x - color.z * 0.5;
    return vec3(t + color.y * 0.5, color.x + color.z * 0.5, t - color.y * 0.5);
}

float bilateralAo(vec2 uv, float centerDepth, vec3 centerNormal) {
    vec2 aoTexel = 1.0 / vec2(textureSize(gtaoTexture, 0));
    float ao = 0.0;
    float weightSum = 0.0;
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            vec2 sampleUv = uv + vec2(x, y) * aoTexel;
            float sampleDepth = texture(depthTexture, sampleUv).r;
            vec3 sampleNormal = normalize(texture(geometryTexture, sampleUv).xyz * 2.0 - 1.0);
            float depthWeight = exp(-abs(sampleDepth - centerDepth) * 900.0);
            float normalWeight = pow(max(dot(centerNormal, sampleNormal), 0.0), 8.0);
            float spatialWeight = (x == 0 && y == 0) ? 1.0 : ((x == 0 || y == 0) ? 0.72 : 0.48);
            float weight = max(depthWeight * normalWeight, 0.015) * spatialWeight;
            ao += texture(gtaoTexture, sampleUv).r * weight;
            weightSum += weight;
        }
    }
    return ao / max(weightSum, 1e-5);
}

void main() {
    vec2 size = vec2(textureSize(currentColorTexture, 0));
    vec2 texel = 1.0 / size;
    vec2 uv = gl_FragCoord.xy * texel;
    float depth = texture(depthTexture, uv).r;
    vec3 normal = normalize(texture(geometryTexture, uv).xyz * 2.0 - 1.0);

    float ao = 1.0;
    // Reverse-Z: the cleared sky keeps depth 0.
    if (depth > 0.00001) {
        ao = bilateralAo(uv, depth, normal);
    }
    // Post AO cannot distinguish direct from indirect light in the compact
    // hybrid path, so keep direct/emissive energy and apply most (not all) of
    // the occlusion. This avoids dirty sunlit surfaces and crushed torches.
    float aoLighting = mix(1.0, ao, 0.72);
    vec3 current = texture(currentColorTexture, uv).rgb * aoLighting;

    vec2 previousUv = uv;
    float predictedPreviousDepth = depth;
    if (depth > 0.00001) {
        vec3 world = reconstructWorld(uv, depth);
        vec4 previousClip = temporal.previousViewProjection * vec4(world, 1.0);
        if (abs(previousClip.w) > 1e-6) {
            vec3 previousNdc = previousClip.xyz / previousClip.w;
            previousUv = previousNdc.xy * 0.5 + 0.5;
            predictedPreviousDepth = previousNdc.z;
        }
    }

    vec3 neighborhoodMin = vec3(1e20);
    vec3 neighborhoodMax = vec3(-1e20);
    vec3 neighborhoodMean = vec3(0.0);
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            vec3 sampleColor = texture(currentColorTexture, uv + vec2(x, y) * texel).rgb * aoLighting;
            vec3 encoded = rgbToYCoCg(sampleColor);
            neighborhoodMin = min(neighborhoodMin, encoded);
            neighborhoodMax = max(neighborhoodMax, encoded);
            neighborhoodMean += encoded;
        }
    }
    neighborhoodMean /= 9.0;
    vec3 extent = (neighborhoodMax - neighborhoodMin) * 0.55 + vec3(0.002);
    neighborhoodMin = max(neighborhoodMin, neighborhoodMean - extent);
    neighborhoodMax = min(neighborhoodMax, neighborhoodMean + extent);

    bool insideHistory = all(greaterThanEqual(previousUv, vec2(0.001))) &&
                         all(lessThanEqual(previousUv, vec2(0.999)));
    vec4 historySample = insideHistory ? texture(previousHistoryTexture, previousUv) : vec4(0.0);
    vec3 clippedHistory = yCoCgToRgb(clamp(rgbToYCoCg(historySample.rgb), neighborhoodMin, neighborhoodMax));
    float depthAgreement = 1.0 - smoothstep(0.0008, 0.008, abs(historySample.a - predictedPreviousDepth));
    vec2 velocityPixels = (previousUv - uv) * size;
    float motion = clamp(length(velocityPixels) * 0.035, 0.0, 1.0);
    float historyWeight = mix(0.92, 0.68, motion) * depthAgreement;
    if (!insideHistory || historySample.a <= 0.0) {
        historyWeight = 0.0;
    }
    // The procedural sky is already analytic and does not receive projection
    // jitter. Keeping temporal history there only creates trails around the
    // sun/moon during fast camera rotations.
    if (depth <= 0.00001) {
        historyWeight = 0.0;
    }

    vec3 resolved = mix(current, clippedHistory, historyWeight);
    outHistory = vec4(max(resolved, vec3(0.0)), depth);
}
