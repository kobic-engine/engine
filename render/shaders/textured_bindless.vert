#version 450

// Bindless variant of textured.vert. Identical to the classic vertex shader
// except it reads two extra per-instance uvec4 attributes (the bindless
// texture-index block at instance-record offset 96) and forwards them flat
// to the fragment shader so it can index the global texture[] array.

layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
layout(location = 2) in vec3 inColor;
layout(location = 3) in vec4 instanceColumn0;
layout(location = 4) in vec4 instanceColumn1;
layout(location = 5) in vec4 instanceColumn2;
layout(location = 6) in vec4 instanceColumn3;
layout(location = 7) in vec2 inUv;
layout(location = 8) in vec4 instanceMaterial;
layout(location = 9) in vec4 shadowColumn0;
layout(location = 10) in vec4 shadowColumn1;
layout(location = 11) in vec4 shadowColumn2;
layout(location = 12) in vec4 shadowColumn3;
layout(location = 13) in vec4 shadowColumn4;
layout(location = 14) in vec4 shadowColumn5;
layout(location = 15) in vec4 shadowColumn6;
layout(location = 16) in vec4 shadowColumn7;
layout(location = 17) in vec4 shadowParams;
layout(location = 18) in vec4 shadowSplits;
layout(location = 19) in vec4 shadowFilter;
layout(location = 20) in vec4 instanceUvTransform;
layout(location = 21) in uvec4 instanceTexIndex0;  // albedo, emissive, normal, metallicRoughness
layout(location = 22) in uvec4 instanceTexIndex1;  // occlusion, spare, spare, spare

layout(std430, set = 1, binding = 1) readonly buffer SkinBuffer { vec4 skinData[]; };

mat4 vertexSkin(uint record) {
    if (record == 0u) return mat4(1.0);
    vec4 header = skinData[record - 1u];
    uint vertex = uint(gl_VertexIndex);
    if (vertex >= uint(header.z)) return mat4(1.0);
    uint at = uint(header.x) + vertex * 2u;
    uvec4 joints = uvec4(skinData[at]);
    vec4 weights = skinData[at + 1u];
    mat4 result = mat4(0.0);
    for (uint i = 0u; i < 4u; ++i) {
        if (weights[i] > 0.0 && joints[i] < uint(header.w)) {
            uint b = uint(header.y) + joints[i] * 4u;
            result += weights[i] * mat4(skinData[b], skinData[b+1u], skinData[b+2u], skinData[b+3u]);
        }
    }
    return result;
}

layout(location = 0) out vec3 fragmentColor;
layout(location = 1) out vec2 fragmentUv;
layout(location = 2) out float fragmentFogDistance;
layout(location = 3) out vec3 fragmentWorldPosition;
layout(location = 4) flat out vec4 fragmentMaterial;
layout(location = 5) out vec4 fragmentShadowPosition0;
layout(location = 6) out vec4 fragmentShadowPosition1;
layout(location = 7) flat out vec4 fragmentShadowParams;
layout(location = 8) flat out vec4 fragmentShadowSplits;
layout(location = 9) flat out vec4 fragmentShadowFilter;
layout(location = 10) out vec3 fragmentWorldNormal;
layout(location = 11) flat out uvec4 fragmentTexIndex0;
layout(location = 12) flat out uvec4 fragmentTexIndex1;
layout(location = 13) flat out vec4 fragmentUvTransform;

layout(push_constant) uniform PushConstants {
    mat4 viewProjection;
    vec4 fogColor;
    vec4 fogParams;
    vec4 fogShapeProjectionLight;
    vec4 lightDirectionIntensity;
} pushConstants;

void main() {
    mat4 model = mat4(
        instanceColumn0,
        instanceColumn1,
        instanceColumn2,
        instanceColumn3
    );
    vec4 localPosition = vec4(inPosition, 1.0);
    vec3 localNormal = inNormal;
    if (instanceTexIndex1.y != 0u) {
        mat4 skin = vertexSkin(instanceTexIndex1.y);
        localPosition = skin * localPosition;
        localNormal = mat3(skin) * localNormal;
    }
    vec4 worldPosition = model * localPosition;
    vec3 vertexColor = inColor;

    // Interactive foliage packs flexibility8 + tintRGB555 into color.r and
    // stores its shared world-space root XZ in color.gb. Ordinary colors stay
    // in 0..1 and skip this path. The compact tag adds no vertex bandwidth.
    if (inColor.r >= 1.999) {
        float foliagePayload = floor(inColor.r - 2.0 + 0.5);
        float flexibility = mod(foliagePayload, 256.0) / 255.0;
        vertexColor = vec3(
            floor(mod(foliagePayload / 256.0, 32.0)),
            floor(mod(foliagePayload / 8192.0, 32.0)),
            floor(mod(foliagePayload / 262144.0, 32.0))
        ) / 31.0;
        float interactionPayload = abs(pushConstants.fogShapeProjectionLight.x);
        float interactionTime = mod(floor(interactionPayload / 2.0), 32768.0) / 32.0;
        float motionEnergy = floor(interactionPayload / 65536.0) / 255.0;
        // The foliage actor (Engine.set_foliage_actor), else the camera.
        vec3 cameraPosition = pushConstants.fogShapeProjectionLight.yzw;
        vec2 awayDelta = inColor.gb - cameraPosition.xz;
        float playerDistance = length(awayDelta);
        float horizontalInfluence = 1.0 - smoothstep(0.35, 1.55, playerDistance);
        float verticalInfluence = 1.0 - smoothstep(
            2.20,
            3.50,
            abs(cameraPosition.y - worldPosition.y)
        );
        float phaseSeed = fract(sin(dot(inColor.gb, vec2(12.9898, 78.233))) * 43758.5453);
        float phase = interactionTime * 14.13716694 + phaseSeed * 6.28318531;
        float releaseEnvelope =
            smoothstep(0.25, 0.75, playerDistance) *
            (1.0 - smoothstep(1.25, 2.20, playerDistance));
        float wobble = sin(phase) * 0.24 * releaseEnvelope * motionEnergy;
        float bend = flexibility * (horizontalInfluence + wobble) * verticalInfluence;
        if (abs(bend) > 0.0001) {
            vec2 away = playerDistance > 0.001
                ? awayDelta / playerDistance
                : vec2(0.0, 1.0);
            worldPosition.xz += away * (0.62 * bend);
            worldPosition.y -= 0.10 * bend * bend;
        }
        // Light breeze, only around the actor: a slow seeded sway along a
        // fixed wind with a faint cross flutter, gusting over ~17 s and
        // fading out between 16 and 26 m so distant plants stay still.
        float breezeFade = 1.0 - smoothstep(16.0, 26.0, playerDistance);
        if (breezeFade > 0.0 && flexibility > 0.0) {
            float gust = 0.55 + 0.45 * sin(interactionTime * 0.37 + inColor.g * 0.045 + inColor.b * 0.031);
            float sway = sin(interactionTime * 2.1 + phaseSeed * 6.28318531) * 0.65
                + sin(interactionTime * 3.7 + phaseSeed * 11.0) * 0.35;
            float flutter = sin(interactionTime * 5.3 + phaseSeed * 17.0);
            float breeze = flexibility * gust * breezeFade;
            worldPosition.xz += vec2(0.8, 0.6) * (0.075 * breeze * sway) + vec2(-0.6, 0.8) * (0.018 * breeze * flutter);
        }
    }
    vec4 clipPosition = pushConstants.viewProjection * worldPosition;
    bool viewmodel = instanceMaterial.z < 0.0;
    if (viewmodel) {
        // Retain camera FOV/XY, but bypass its world near/far depth range:
        // reverse-Z band [1 - 1e-4, 1], nearer than any world surface.
        // Positive-w clipping and perspective-correct self-occlusion remain.
        clipPosition.z = clipPosition.w >= 0.02
            ? clipPosition.w - 0.0001 * (clipPosition.w - 0.02) : clipPosition.w + 1.0;
    }

    gl_Position = clipPosition;
    fragmentColor = vertexColor;
    float packedMaterial = max(floor(instanceMaterial.w + 0.5), 0.0);
    float worldPixelSampling = mod(floor(packedMaterial / 8388608.0), 2.0);
    fragmentUv = inUv;
    if (worldPixelSampling < 0.5) {
        fragmentUv = inUv * instanceUvTransform.xy + instanceUvTransform.zw;
    }
    fragmentUvTransform = instanceUvTransform;
    fragmentFogDistance = viewmodel ? 0.0 : abs(clipPosition.w);
    fragmentWorldPosition = worldPosition.xyz;
    fragmentMaterial = instanceMaterial;
    if (viewmodel) fragmentMaterial.z = -1.0 - fragmentMaterial.z;
    mat3 normalMatrix = transpose(inverse(mat3(model)));
    fragmentWorldNormal = normalMatrix * localNormal;
    fragmentShadowPosition0 = mat4(
        shadowColumn0,
        shadowColumn1,
        shadowColumn2,
        shadowColumn3
    ) * worldPosition;
    fragmentShadowPosition1 = mat4(
        shadowColumn4,
        shadowColumn5,
        shadowColumn6,
        shadowColumn7
    ) * worldPosition;
    fragmentShadowParams = shadowParams;
    fragmentShadowSplits = shadowSplits;
    fragmentShadowFilter = shadowFilter;
    fragmentTexIndex0 = instanceTexIndex0;
    fragmentTexIndex1 = instanceTexIndex1;
}
