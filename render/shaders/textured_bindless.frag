#version 450
#extension GL_EXT_nonuniform_qualifier : require

// Bindless variant of textured.frag. The 5 per-material samplers (albedo,
// emissive, normal, metallic-roughness, occlusion) are replaced by a single
// global descriptor array `textures[]` at set 2, indexed per-instance via the
// texIndex block forwarded from the vertex shader. The shadow sampler (set 0
// binding 1) and the point-light UBO (set 1) are unchanged, as are the push
// constants — so the lighting/shadow math is byte-for-byte the classic path.

layout(set = 0, binding = 1) uniform sampler2DShadow shadowSampler;

layout(set = 2, binding = 0) uniform sampler2D textures[];

const int MAX_POINT_LIGHTS = 8;
const float PI = 3.14159265359;

layout(set = 1, binding = 0) uniform PointLightBlock {
    vec4 meta;
    vec4 positionRange[MAX_POINT_LIGHTS];
    vec4 colorEnergy[MAX_POINT_LIGHTS];
    vec4 skyZenith;
    vec4 skyHorizon;
    vec4 skyLower;
    vec4 environmentLighting;
    vec4 skyUpCurve;
    vec4 horizonGlowDirection;
    vec4 horizonGlowColor;
    vec4 styleLight;
    vec4 styleShadow;
    vec4 styleSun;
    vec4 styleGrade;
    vec4 styleVariation;
    vec4 stylePlanetCenter;
    vec4 stylePlanetAxis;
} pointLights;

// Texel-snapped lighting inputs (see styleResolveSnappedInputs).
vec4 styleShadowPosition0;
vec4 styleShadowPosition1;
vec3 styleWorldNormal;

layout(location = 0) in vec3 fragmentColor;
layout(location = 1) in vec2 fragmentUv;
layout(location = 2) in float fragmentFogDistance;
layout(location = 3) in vec3 fragmentWorldPosition;
layout(location = 4) flat in vec4 fragmentMaterial;
layout(location = 5) in vec4 fragmentShadowPosition0;
layout(location = 6) in vec4 fragmentShadowPosition1;
layout(location = 7) flat in vec4 fragmentShadowParams;
layout(location = 8) flat in vec4 fragmentShadowSplits;
layout(location = 9) flat in vec4 fragmentShadowFilter;
layout(location = 10) in vec3 fragmentWorldNormal;
layout(location = 11) flat in uvec4 fragmentTexIndex0;
layout(location = 12) flat in uvec4 fragmentTexIndex1;
layout(location = 13) flat in vec4 fragmentUvTransform;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outGeometry;

layout(push_constant) uniform PushConstants {
    mat4 viewProjection;
    vec4 fogColor;
    vec4 fogParams;
    vec4 fogShapeProjectionLight;
    vec4 lightDirectionIntensity;
} pushConstants;

float hasWorldPixelSampling() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 8388608.0), 2.0);
}

float worldSurfaceEffect() {
    if (hasWorldPixelSampling() < 0.5) {
        return 0.0;
    }
    float hintCode = floor(fract(fragmentUv.x) * 16.0 + 0.5);
    return mod(hintCode, 2.0);
}

float hasWorldFarColor() {
    if (hasWorldPixelSampling() < 0.5) {
        return 0.0;
    }
    // World-pixel meshes reserve the exact 0.75 U fraction for distant
    // color-only geometry. The atlas cell remains floor(U), while the far
    // path can avoid every albedo/atlas sampling instruction.
    return 1.0 - step(0.001, abs(fract(fragmentUv.x) - 0.75));
}

// World-pixel meshes may store inverse sky visibility in the unused fractional
// V range [0.5, 0.99]. The normal atlas-center value 0.5 remains fully exposed,
// preserving every existing mesh/material without another vertex attribute.
float skyVisibility() {
    if (hasWorldPixelSampling() < 0.5) {
        return 1.0;
    }
    float encodedOcclusion = clamp((fract(fragmentUv.y) - 0.5) / 0.49, 0.0, 1.0);
    return 1.0 - encodedOcclusion;
}

struct TextureCoordinates {
    vec2 uv;
    vec2 dx;
    vec2 dy;
};

TextureCoordinates resolveTextureCoordinates(vec2 meshUv, vec2 textureSizePixels) {
    TextureCoordinates result;
    result.uv = meshUv;
    result.dx = dFdx(meshUv);
    result.dy = dFdy(meshUv);
    if (hasWorldPixelSampling() < 0.5) {
        return result;
    }

    vec2 grid = max(fragmentUvTransform.xy, vec2(1.0));
    float padding = clamp(fragmentUvTransform.z, 0.0, 0.49);
    float usable = 1.0 - padding * 2.0;
    vec3 normalWeight = abs(normalize(fragmentWorldNormal));
    // Smooth world-pixel meshes can encode a stable projection axis in the
    // otherwise-unused fractional mesh U: X=0.125, Y=0.375, Z=0.875.
    // The legacy 0.5 center keeps automatic dominant-normal projection.
    float projectionHint = fract(meshUv.x) - worldSurfaceEffect() * 0.0625;
    vec2 worldUv;
    if (projectionHint < 0.25) {
        worldUv = vec2(fragmentWorldPosition.z, -fragmentWorldPosition.y);
    } else if (projectionHint < 0.45) {
        worldUv = fragmentWorldPosition.xz;
    } else if (projectionHint > 0.75) {
        worldUv = vec2(fragmentWorldPosition.x, -fragmentWorldPosition.y);
    } else if (normalWeight.y >= normalWeight.x && normalWeight.y >= normalWeight.z) {
        worldUv = fragmentWorldPosition.xz;
    } else if (normalWeight.x >= normalWeight.z) {
        worldUv = vec2(fragmentWorldPosition.z, -fragmentWorldPosition.y);
    } else {
        worldUv = vec2(fragmentWorldPosition.x, -fragmentWorldPosition.y);
    }
    // Same atlas-only scale and legacy default as the classic path.
    float repeatScale = fragmentUvTransform.w;
    repeatScale = (repeatScale > 0.0 && repeatScale <= 16.0) ? max(repeatScale, 0.0625) : 1.0;
    worldUv *= repeatScale;
    vec2 tile = floor(meshUv);
    result.uv = (tile + vec2(padding) + fract(worldUv) * usable) / grid;
    result.dx = dFdx(worldUv) * usable / grid;
    result.dy = dFdy(worldUv) * usable / grid;

    // Never select a mip smaller than one texel per atlas cell. Lower levels
    // merge neighboring materials and produce distant green/brown color bleed.
    vec2 cellSize = max(textureSizePixels / grid, vec2(1.0));
    float maxSafeMip = floor(log2(max(min(cellSize.x, cellSize.y), 1.0)));
    float maxSafeFootprint = exp2(maxSafeMip);
    float footprint = max(
        length(result.dx * textureSizePixels),
        length(result.dy * textureSizePixels)
    );
    if (footprint > maxSafeFootprint) {
        float gradientScale = maxSafeFootprint / footprint;
        result.dx *= gradientScale;
        result.dy *= gradientScale;
    }
    return result;
}

// Bindless sampling helpers — index the global table with a nonuniform index.
vec4 sampleAlbedo(TextureCoordinates coordinates) {
    return textureGrad(textures[nonuniformEXT(fragmentTexIndex0.x)], coordinates.uv, coordinates.dx, coordinates.dy);
}
vec4 sampleEmissive(TextureCoordinates coordinates) {
    return textureGrad(textures[nonuniformEXT(fragmentTexIndex0.y)], coordinates.uv, coordinates.dx, coordinates.dy);
}
vec4 sampleNormalMap(TextureCoordinates coordinates) {
    return textureGrad(textures[nonuniformEXT(fragmentTexIndex0.z)], coordinates.uv, coordinates.dx, coordinates.dy);
}
vec4 sampleMetallicRoughness(TextureCoordinates coordinates) {
    return textureGrad(textures[nonuniformEXT(fragmentTexIndex0.w)], coordinates.uv, coordinates.dx, coordinates.dy);
}
vec4 sampleOcclusion(TextureCoordinates coordinates) {
    return textureGrad(textures[nonuniformEXT(fragmentTexIndex1.x)], coordinates.uv, coordinates.dx, coordinates.dy);
}

vec4 unpackLight() {
    float packed = max(floor(pushConstants.fogColor.a + 0.5), 0.0);
    float red = mod(packed, 64.0);
    packed = floor(packed / 64.0);
    float green = mod(packed, 64.0);
    packed = floor(packed / 64.0);
    float blue = mod(packed, 64.0);
    packed = floor(packed / 64.0);
    float ambient = mod(packed, 64.0);
    return vec4(red, green, blue, ambient) / 63.0;
}

float fogDistanceForFragment() {
    if (pushConstants.fogShapeProjectionLight.x > 0.5) {
        vec3 cameraPosition = vec3(
            pushConstants.fogShapeProjectionLight.y,
            pushConstants.fogShapeProjectionLight.z,
            pushConstants.fogShapeProjectionLight.w
        );
        return length(fragmentWorldPosition - cameraPosition);
    }
    return fragmentFogDistance;
}

vec4 unpackEmissive() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    float red = mod(packed, 32.0);
    packed = floor(packed / 32.0);
    float green = mod(packed, 32.0);
    packed = floor(packed / 32.0);
    float blue = mod(packed, 32.0);
    packed = floor(packed / 32.0);
    float unlit = mod(packed, 2.0);
    return vec4(red / 31.0, green / 31.0, blue / 31.0, unlit);
}

float receivesShadow() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 65536.0), 2.0);
}

float hasEmissiveMap() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 131072.0), 2.0);
}

float hasNormalMap() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 262144.0), 2.0);
}

float hasMetallicRoughnessMap() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 524288.0), 2.0);
}

float hasOcclusionMap() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 1048576.0), 2.0);
}

float hasAlphaClip() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 2097152.0), 2.0);
}

float isDoubleSided() {
    float packed = max(floor(fragmentMaterial.w + 0.5), 0.0);
    return mod(floor(packed / 4194304.0), 2.0);
}

mat3 normalMapFrame(vec3 normal, vec3 worldPosition, vec2 uv) {
    vec3 dpdx = dFdx(worldPosition);
    vec3 dpdy = dFdy(worldPosition);
    vec2 duvdx = dFdx(uv);
    vec2 duvdy = dFdy(uv);
    vec3 tangent = cross(dpdy, normal) * duvdx.x + cross(normal, dpdx) * duvdy.x;
    vec3 bitangent = cross(dpdy, normal) * duvdx.y + cross(normal, dpdx) * duvdy.y;
    float scale = inversesqrt(max(dot(tangent, tangent), dot(bitangent, bitangent)));
    return mat3(tangent * scale, bitangent * scale, normal);
}

float distributionGGX(vec3 normal, vec3 halfVector, float roughness) {
    float alpha = roughness * roughness;
    float alphaSquared = alpha * alpha;
    float normalHalf = max(dot(normal, halfVector), 0.0);
    float normalHalfSquared = normalHalf * normalHalf;
    float denominator = normalHalfSquared * (alphaSquared - 1.0) + 1.0;
    return alphaSquared / max(PI * denominator * denominator, 0.0001);
}

float geometrySchlickGGX(float normalVector, float roughness) {
    float r = roughness + 1.0;
    float k = (r * r) * 0.125;
    return normalVector / max(normalVector * (1.0 - k) + k, 0.0001);
}

float geometrySmith(vec3 normal, vec3 viewDirection, vec3 lightDirection, float roughness) {
    float normalView = max(dot(normal, viewDirection), 0.0);
    float normalLight = max(dot(normal, lightDirection), 0.0);
    return geometrySchlickGGX(normalView, roughness) * geometrySchlickGGX(normalLight, roughness);
}

vec3 fresnelSchlick(float cosine, vec3 baseReflectance) {
    return baseReflectance + (1.0 - baseReflectance) * pow(1.0 - cosine, 5.0);
}

vec3 evaluatePbrLight(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 albedo, float metallic, float roughness, vec3 radiance) {
    vec3 halfVector = normalize(viewDirection + lightDirection);
    vec3 baseReflectance = mix(vec3(0.04), albedo, metallic);
    vec3 fresnel = fresnelSchlick(max(dot(halfVector, viewDirection), 0.0), baseReflectance);
    float distribution = distributionGGX(normal, halfVector, roughness);
    float geometry = geometrySmith(normal, viewDirection, lightDirection, roughness);
    float normalView = max(dot(normal, viewDirection), 0.0);
    float normalLight = max(dot(normal, lightDirection), 0.0);
    vec3 specular = (distribution * geometry * fresnel) / max(4.0 * normalView * normalLight, 0.0001);
    vec3 diffuse = (1.0 - fresnel) * (1.0 - metallic) * albedo / PI;
    return (diffuse + specular) * radiance * normalLight;
}

vec3 evaluateSkyGradient(vec3 direction, vec3 localUp, vec3 zenith, vec3 horizon,
    vec3 lower, float curve, vec3 glowDirection, vec3 glowColor,
    float glowStrength, float glowExtent);

vec3 sampleSkyLighting(vec3 direction) {
    return evaluateSkyGradient(direction, pointLights.skyUpCurve.xyz,
        pointLights.skyZenith.rgb, pointLights.skyHorizon.rgb, pointLights.skyLower.rgb,
        pointLights.skyUpCurve.w, pointLights.horizonGlowDirection.xyz,
        pointLights.horizonGlowColor.rgb, pointLights.horizonGlowDirection.w, pointLights.horizonGlowColor.w);
}

vec3 evaluateSkyLighting(vec3 normal, vec3 viewDirection, vec3 albedo, float metallic, float roughness) {
    vec3 baseReflectance = mix(vec3(0.04), albedo, metallic);
    float normalView = max(dot(normal, viewDirection), 0.0);
    vec3 fresnel = fresnelSchlick(normalView, baseReflectance);
    vec3 diffuseWeight = (1.0 - fresnel) * (1.0 - metallic);
    vec3 diffuse = diffuseWeight * albedo / PI;

    vec3 diffuseIrradiance = sampleSkyLighting(normal);
    vec3 reflectionDirection = reflect(-viewDirection, normal);
    vec3 sharpReflection = sampleSkyLighting(reflectionDirection);
    vec3 roughReflection = sampleSkyLighting(normal);
    vec3 specularIrradiance = mix(sharpReflection, roughReflection, roughness * roughness);
    float specularFade = 1.0 - roughness * 0.65;

    return diffuse * diffuseIrradiance * pointLights.environmentLighting.x
        + fresnel * specularIrradiance * pointLights.environmentLighting.y * specularFade;
}

vec2 receiverPlaneDepthGradient(vec2 uv, float depth) {
    vec2 uvDx = dFdx(uv);
    vec2 uvDy = dFdy(uv);
    vec2 depthDerivatives = vec2(dFdx(depth), dFdy(depth));
    float determinant = uvDx.x * uvDy.y - uvDx.y * uvDy.x;
    if (abs(determinant) < 0.0000001) {
        return vec2(0.0);
    }

    return vec2(
        (uvDy.y * depthDerivatives.x - uvDx.y * depthDerivatives.y) / determinant,
        (-uvDy.x * depthDerivatives.x + uvDx.x * depthDerivatives.y) / determinant
    );
}

float shadowNoise(vec2 position) {
    return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715))));
}

float shadowDistanceFade(float distanceFromCamera, float maxDistance, float fadeDistance) {
    if (fadeDistance <= 0.0001 || maxDistance <= 0.0001) {
        return 1.0;
    }
    float clampedFade = min(fadeDistance, maxDistance);
    float fadeStart = max(maxDistance - clampedFade, 0.0);
    return 1.0 - smoothstep(fadeStart, maxDistance, distanceFromCamera);
}

float sampleShadowCascade(
    vec4 shadowPosition,
    vec4 gradientPosition,
    vec2 atlasOffset,
    vec2 atlasScale,
    vec3 normal,
    vec3 lightDirection,
    float bias,
    float normalBias,
    float softness,
    float filterQuality
) {
    if (shadowPosition.w <= 0.0) {
        return -1.0;
    }

    vec3 projected = shadowPosition.xyz / shadowPosition.w;
    vec2 localUv = projected.xy * 0.5 + 0.5;
    if (localUv.x <= 0.0 || localUv.x >= 1.0 || localUv.y <= 0.0 || localUv.y >= 1.0) {
        return -1.0;
    }
    if (projected.z <= 0.0 || projected.z >= 1.0) {
        return -1.0;
    }

    float normalLight = max(dot(normal, -lightDirection), 0.0);
    if (normalLight <= 0.0001) {
        return 1.0;
    }

    float sine = sqrt(max(1.0 - normalLight * normalLight, 0.0));
    float slope = min(sine / max(normalLight, 0.16), 3.0);
    vec2 atlasUv = atlasOffset + localUv * atlasScale;
    vec2 texel = 1.0 / vec2(textureSize(shadowSampler, 0));
    vec2 localTexel = texel / max(atlasScale, vec2(0.0001));
    vec3 gradientProjected = gradientPosition.xyz / gradientPosition.w;
    vec2 receiverGradient = receiverPlaneDepthGradient(gradientProjected.xy * 0.5 + 0.5, gradientProjected.z);
    float receiverFootprint = abs(receiverGradient.x) * localTexel.x
        + abs(receiverGradient.y) * localTexel.y;
    float receiverBiasLimit = bias + normalBias * 1.25;
    float receiverBias = min(receiverFootprint * 0.35, receiverBiasLimit);
    float depthBias = max(bias, bias + normalBias * slope * 0.55 + receiverBias);

    float clampedSoftness = clamp(softness, 0.0, 1.0);
    float grazingWeight = smoothstep(0.025, 0.16, normalLight);
    float edgeFade = smoothstep(0.0, 0.035, localUv.x)
        * smoothstep(0.0, 0.035, localUv.y)
        * smoothstep(0.0, 0.035, 1.0 - localUv.x)
        * smoothstep(0.0, 0.035, 1.0 - localUv.y);

    if (clampedSoftness <= 0.01) {
        float visibility = texture(shadowSampler, vec3(atlasUv, projected.z - depthBias));
        return mix(1.0, mix(1.0, visibility, grazingWeight), edgeFade);
    }

    const vec2 diskSamples[40] = vec2[](
        vec2( 0.000000,  0.000000),
        vec2( 0.350000,  0.000000),
        vec2( 0.247487,  0.247487),
        vec2( 0.000000,  0.350000),
        vec2(-0.247487,  0.247487),
        vec2(-0.350000,  0.000000),
        vec2(-0.247487, -0.247487),
        vec2( 0.000000, -0.350000),
        vec2( 0.247487, -0.247487),
        vec2( 0.650000,  0.000000),
        vec2( 0.562917,  0.325000),
        vec2( 0.325000,  0.562917),
        vec2( 0.000000,  0.650000),
        vec2(-0.325000,  0.562917),
        vec2(-0.562917,  0.325000),
        vec2(-0.650000,  0.000000),
        vec2(-0.562917, -0.325000),
        vec2(-0.325000, -0.562917),
        vec2( 0.000000, -0.650000),
        vec2( 0.325000, -0.562917),
        vec2( 0.562917, -0.325000),
        vec2( 1.000000,  0.000000),
        vec2( 0.923880,  0.382683),
        vec2( 0.707107,  0.707107),
        vec2( 0.382683,  0.923880),
        vec2( 0.000000,  1.000000),
        vec2(-0.382683,  0.923880),
        vec2(-0.707107,  0.707107),
        vec2(-0.923880,  0.382683),
        vec2(-1.000000,  0.000000),
        vec2(-0.923880, -0.382683),
        vec2(-0.707107, -0.707107),
        vec2(-0.382683, -0.923880),
        vec2( 0.000000, -1.000000),
        vec2( 0.382683, -0.923880),
        vec2( 0.707107, -0.707107),
        vec2( 0.923880, -0.382683),
        vec2( 0.180240,  0.830640),
        vec2(-0.830640,  0.180240),
        vec2( 0.830640, -0.180240)
    );

    int qualityLevel = int(clamp(floor(filterQuality + 0.5), 0.0, 3.0));
    int requestedSamples = int(clamp(floor(fragmentShadowFilter.y + 0.5), 0.0, 40.0));
    float requestedRadius = clamp(fragmentShadowFilter.z, 0.0, 16.0);
    int sampleCount = 4;
    if (qualityLevel == 0) {
        if (clampedSoftness > 0.67) {
            sampleCount = 6;
        }
    } else if (qualityLevel == 1) {
        sampleCount = 6;
        if (clampedSoftness > 0.34) {
            sampleCount = 8;
        }
        if (clampedSoftness > 0.67) {
            sampleCount = 12;
        }
    } else if (qualityLevel == 2) {
        sampleCount = 8;
        if (clampedSoftness > 0.34) {
            sampleCount = 12;
        }
        if (clampedSoftness > 0.67) {
            sampleCount = 16;
        }
        if (clampedSoftness > 0.92) {
            sampleCount = 28;
        }
    } else {
        sampleCount = 12;
        if (clampedSoftness > 0.34) {
            sampleCount = 20;
        }
        if (clampedSoftness > 0.67) {
            sampleCount = 28;
        }
        if (clampedSoftness > 0.92) {
            sampleCount = 40;
        }
    }
    if (requestedSamples > 0) {
        sampleCount = requestedSamples;
    }

    float radius = 0.90 + clampedSoftness * 3.40;
    if (requestedRadius > 0.0) {
        radius = requestedRadius;
    }
    float visibility = 0.0;
    float totalWeight = 0.0;
    for (int index = 0; index < sampleCount; ++index) {
        vec2 disk = diskSamples[index];
        float weight = 1.15 - length(disk) * 0.35;
        vec2 atlasOffsetSample = disk * texel * radius;
        vec2 localOffsetSample = atlasOffsetSample / max(atlasScale, vec2(0.0001));
        float sampleDepth = projected.z
            + dot(receiverGradient, localOffsetSample)
            - depthBias;
        visibility += texture(shadowSampler, vec3(atlasUv + atlasOffsetSample, sampleDepth)) * weight;
        totalWeight += weight;
    }
    if (totalWeight > 0.0) {
        visibility /= totalWeight;
    } else {
        visibility = texture(shadowSampler, vec3(atlasUv, projected.z - depthBias));
    }

    return mix(1.0, mix(1.0, visibility, grazingWeight), edgeFade);
}

float sampleShadow(vec3 normal, vec3 lightDirection) {
    if (fragmentShadowParams.x < 0.5 || receivesShadow() < 0.5) {
        return 1.0;
    }

    int cascadeCount = int(clamp(floor(fragmentShadowSplits.x + 0.5), 1.0, 2.0));
    float softness = fragmentShadowParams.w;
    float filterQuality = fragmentShadowFilter.x;
    float fadeDistance = fragmentShadowFilter.w;
    float cascadeDistance = fogDistanceForFragment();
    float maxShadowDistance = fragmentShadowSplits.y;
    if (cascadeCount > 1) {
        maxShadowDistance = max(fragmentShadowSplits.y / 0.32, fragmentShadowSplits.y);
    }
    float distanceFade = shadowDistanceFade(cascadeDistance, maxShadowDistance, fadeDistance);
    if (distanceFade <= 0.0001) {
        return 1.0;
    }

    // One cascade-sampling call site (the optimizer inlines every call):
    // a single map uses the whole atlas; with two, the near cascade falls
    // back to the far one outside its bounds, the far one stands alone.
    int firstCascade = 0;
    int lastCascade = 0;
    if (cascadeCount > 1) {
        lastCascade = 1;
        if (cascadeDistance > fragmentShadowSplits.y) {
            firstCascade = 1;
        }
    }
    vec2 atlasScale = cascadeCount > 1 ? vec2(0.5, 0.5) : vec2(1.0, 1.0);
    float selected = -1.0;
    for (int cascade = firstCascade; cascade <= lastCascade; ++cascade) {
        bool far = cascade == 1;
        selected = sampleShadowCascade(
            far ? styleShadowPosition1 : styleShadowPosition0,
            far ? fragmentShadowPosition1 : fragmentShadowPosition0,
            far ? vec2(0.5, 0.0) : vec2(0.0, 0.0),
            atlasScale,
            normal,
            lightDirection,
            far ? fragmentShadowSplits.z : fragmentShadowParams.y,
            far ? fragmentShadowSplits.w : fragmentShadowParams.z,
            softness,
            filterQuality
        );
        if (selected >= 0.0) {
            break;
        }
    }

    if (selected < 0.0) {
        return 1.0;
    }
    return mix(1.0, selected, distanceFade);
}

// Shared by the sky pass and both material paths. Only the authored colors,
// frame, and two cheap directional controls differ between callers.
vec3 evaluateSkyGradient(vec3 direction, vec3 localUp, vec3 zenith, vec3 horizon,
    vec3 lower, float curve, vec3 glowDirection, vec3 glowColor,
    float glowStrength, float glowExtent) {
    vec3 ray = direction * inversesqrt(max(dot(direction, direction), 0.000001));
    float vertical = clamp(dot(ray, localUp), -1.0, 1.0);
    float blend = abs(vertical);
    float gradientPower = clamp(curve, 0.20, 4.0);
    if (gradientPower != 1.0) {
        blend = pow(blend, gradientPower);
    }
    vec3 color = vertical >= 0.0 ? mix(horizon, zenith, blend) : mix(horizon, lower, blend);
    if (glowStrength <= 0.0) {
        return color;
    }
    vec3 rayHorizontal = ray - localUp * vertical;
    vec3 glowHorizontal = glowDirection - localUp * dot(glowDirection, localUp);
    float alignment = max(dot(rayHorizontal, glowHorizontal)
        * inversesqrt(max(dot(rayHorizontal, rayHorizontal), 0.000001))
        * inversesqrt(max(dot(glowHorizontal, glowHorizontal), 0.000001)), 0.0);
    alignment *= alignment;
    float horizonBand = 1.0 - smoothstep(0.0, clamp(glowExtent, 0.05, 1.0), abs(vertical));
    return mix(color, glowColor, clamp(glowStrength, 0.0, 1.0) * alignment * horizonBand);
}

// Stylized pixel lighting (opt-in, Environment.stylized; all zero = off).
// styleLight:  x enabled, y tone bands (0 = smooth), z wrap, w world texels
//              per metre for texel-aligned light (0 = off)
// styleShadow: rgb colour of the unlit side, a = how much it follows the sky
// styleSun:    rgb colour of the lit side, a = cast-shadow strength
// styleGrade:  x saturation, y contrast, z contrast pivot, w sky brightness
//              at noon (lit materials scale their shade by the sky they see)
// styleVariation: x strength, y patch size in metres; world-pixel surfaces
//              take a warm/neutral/cool tint from world noise, dithered per
//              texel
// Face mode (styleLight.x = 2) replaces the tones with voxel-game face
// shading: top 100%, north/south 80%, east/west 60%, bottom 50%, blended by
// the squared normal components in the local frame. stylePlanetCenter (xyz,
// w = 1 when set) and stylePlanetAxis give each pixel its own up, north and
// day/night on a planet; otherwise the sky's up and world axes are used.
// Uniformly lit materials split their energy between a warm lit colour and
// a cool shade. Lit materials use the energy of a face turned to the sun
// (ambient + 0.62 sun, as the classic path) and dim the shade with the sky,
// so night sides and space stay dark.
bool styleEnabled() {
    return pointLights.styleLight.x > 0.5;
}

bool styleFaces() {
    return pointLights.styleLight.x > 1.5;
}

// Local up at this pixel: from the planet centre when known.
vec3 styleLocalUp() {
    if (pointLights.stylePlanetCenter.w > 0.5) {
        vec3 fromCenter = fragmentWorldPosition - pointLights.stylePlanetCenter.xyz;
        if (dot(fromCenter, fromCenter) > 1.0) {
            return normalize(fromCenter);
        }
    }
    vec3 skyUp = pointLights.skyUpCurve.xyz;
    if (dot(skyUp, skyUp) > 0.000001) {
        return normalize(skyUp);
    }
    return vec3(0.0, 1.0, 0.0);
}

// Face brightness: top 1.0, bottom 0.5, north/south 0.8, east/west 0.6.
float styleFaceShade(vec3 normal, vec3 up) {
    vec3 axis = pointLights.stylePlanetAxis.xyz;
    if (dot(axis, axis) < 0.000001) {
        axis = vec3(0.0, 0.0, 1.0);
    }
    vec3 east = cross(normalize(axis), up);
    if (dot(east, east) < 0.000001) {
        east = abs(up.x) < 0.9 ? cross(vec3(1.0, 0.0, 0.0), up) : cross(vec3(0.0, 0.0, 1.0), up);
    }
    east = normalize(east);
    vec3 north = cross(up, east);
    float u = dot(normal, up);
    float e = dot(normal, east);
    float n = dot(normal, north);
    return u * u * (u >= 0.0 ? 1.0 : 0.5) + e * e * 0.6 + n * n * 0.8;
}

// Daylight 0..1 from the sun's height above this pixel's horizon (the same
// dawn curve the game uses for objects).
float styleDaylight(vec3 up, vec3 lightDirection) {
    if (dot(lightDirection, lightDirection) < 0.000001) {
        return 1.0;
    }
    float height = dot(up, -normalize(lightDirection));
    float dawn = clamp((height + 0.14) / 0.36, 0.0, 1.0);
    return dawn * dawn * (3.0 - 2.0 * dawn);
}

// Screen-derivative weights that move this fragment to the centre of its
// world texel on the surface plane. Light and shadow are linear over a
// triangle, so the same weights move them there too and their edges then
// follow the texture's pixels. Must run in uniform control flow.
vec2 styleTexelSnapWeights() {
    vec3 dx = dFdx(fragmentWorldPosition);
    vec3 dy = dFdy(fragmentWorldPosition);
    float texels = pointLights.styleLight.w;
    if (texels <= 0.0) {
        return vec2(0.0);
    }
    vec3 delta = (floor(fragmentWorldPosition * texels) + 0.5) / texels - fragmentWorldPosition;
    float a11 = dot(dx, dx);
    float a12 = dot(dx, dy);
    float a22 = dot(dy, dy);
    float determinant = a11 * a22 - a12 * a12;
    if (determinant <= max(a11 * a22, 1e-30) * 1e-6) {
        return vec2(0.0);
    }
    float b1 = dot(delta, dx);
    float b2 = dot(delta, dy);
    vec2 weights = vec2(a22 * b1 - a12 * b2, a11 * b2 - a12 * b1) / determinant;
    return clamp(weights, vec2(-64.0), vec2(64.0));
}

void styleResolveSnappedInputs() {
    vec2 weights = styleTexelSnapWeights();
    vec4 shadow0 = fragmentShadowPosition0 + weights.x * dFdx(fragmentShadowPosition0) + weights.y * dFdy(fragmentShadowPosition0);
    vec4 shadow1 = fragmentShadowPosition1 + weights.x * dFdx(fragmentShadowPosition1) + weights.y * dFdy(fragmentShadowPosition1);
    vec3 normal = fragmentWorldNormal + weights.x * dFdx(fragmentWorldNormal) + weights.y * dFdy(fragmentWorldNormal);
    bool snap = styleEnabled() && hasWorldPixelSampling() > 0.5 && pointLights.styleLight.w > 0.0;
    styleShadowPosition0 = snap ? shadow0 : fragmentShadowPosition0;
    styleShadowPosition1 = snap ? shadow1 : fragmentShadowPosition1;
    styleWorldNormal = snap ? normal : fragmentWorldNormal;
}

// The lighting normal with the texel snap applied; falls back to `normal`.
vec3 styleNormal(vec3 normal) {
    vec3 snapped = normal + (styleWorldNormal - fragmentWorldNormal);
    if (dot(snapped, snapped) < 0.0001) {
        return normal;
    }
    return normalize(snapped);
}

float styleBand(float value) {
    float bands = floor(pointLights.styleLight.y + 0.5);
    if (bands < 1.0) {
        return value;
    }
    return clamp(floor(value * bands + 0.5) / bands, 0.0, 1.0);
}

// How bright the sky seen by `normal` is relative to the noon reference.
float styleSkyLevel(vec3 normal) {
    float reference = pointLights.styleGrade.w;
    if (reference <= 0.0) {
        return 1.0;
    }
    vec3 sky = sampleSkyLighting(normal);
    return clamp(max(sky.r, max(sky.g, sky.b)) / reference, 0.0, 1.0);
}

// Light colour (to multiply albedo) for a surface of total brightness
// `energy`: lit side = sun colour, unlit/shadowed side = cool shade scaled
// by `shadeLevel`.
vec3 styleLightColor(float energy, vec3 normal, vec3 lightDirection, float shadow, vec3 sunColor, float shadeLevel) {
    float lit = 1.0;
    if (dot(lightDirection, lightDirection) > 0.000001) {
        float wrap = clamp(pointLights.styleLight.z, 0.0, 0.95);
        float facing = dot(normal, -normalize(lightDirection));
        lit = clamp((facing + wrap) / (1.0 + wrap), 0.0, 1.0);
    }
    lit *= mix(1.0, clamp(shadow, 0.0, 1.0), clamp(pointLights.styleSun.a, 0.0, 1.0));
    lit = styleBand(lit);
    vec3 skyHue = sampleSkyLighting(normal);
    float skyPeak = max(skyHue.r, max(skyHue.g, skyHue.b));
    skyHue = skyPeak > 0.001 ? skyHue / skyPeak : vec3(1.0);
    vec3 shade = pointLights.styleShadow.rgb * mix(vec3(1.0), skyHue, clamp(pointLights.styleShadow.a, 0.0, 1.0)) * shadeLevel;
    vec3 sun = pointLights.styleSun.rgb * sunColor;
    return mix(shade, sun, lit) * energy;
}

float styleHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float styleValueNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(styleHash(i), styleHash(i + vec3(1, 0, 0)), f.x),
            mix(styleHash(i + vec3(0, 1, 0)), styleHash(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(styleHash(i + vec3(0, 0, 1)), styleHash(i + vec3(1, 0, 1)), f.x),
            mix(styleHash(i + vec3(0, 1, 1)), styleHash(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
}

// Large warm/neutral/cool patches on world-pixel surfaces. Evaluated per
// world texel with a 4x4 ordered dither between the three tones, so the
// transitions are pixel-art dithering instead of gradients.
vec3 styleVariationTint() {
    float strength = pointLights.styleVariation.x;
    float scale = pointLights.styleVariation.y;
    if (strength <= 0.0 || scale <= 0.0) {
        return vec3(1.0);
    }
    float texels = max(pointLights.styleLight.w, 1.0);
    vec3 cell = floor(fragmentWorldPosition * texels);
    vec3 position = (cell + 0.5) / texels;
    float noise = styleValueNoise(position / scale) * 0.65 + styleValueNoise(position / (scale * 0.37) + 17.0) * 0.35;
    const float bayer[16] = float[](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    ivec2 ditherCell = ivec2(mod(cell.x + cell.y, 4.0), mod(cell.z + cell.y, 4.0));
    float threshold = (bayer[ditherCell.y * 4 + ditherCell.x] + 0.5) / 16.0 - 0.5;
    float tone = clamp(floor(clamp((noise - 0.5) * 1.8 + 0.5, 0.0, 1.0) * 2.0 + 0.5 + threshold), 0.0, 2.0);
    vec3 warm = vec3(1.10, 1.05, 0.80);
    vec3 cool = vec3(0.88, 0.98, 1.06);
    vec3 tint = tone < 0.5 ? warm : (tone < 1.5 ? vec3(1.0) : cool);
    return mix(vec3(1.0), tint, clamp(strength, 0.0, 1.0));
}

vec3 styleGradeColor(vec3 color) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, pointLights.styleGrade.x);
    float pivot = pointLights.styleGrade.z;
    color = (color - pivot) * pointLights.styleGrade.y + pivot;
    return max(color, vec3(0.0));
}

void main() {
    styleResolveSnappedInputs();
    if (isDoubleSided() < 0.5 && !gl_FrontFacing) {
        discard;
    }
    float farColorSurface = hasWorldFarColor();
    TextureCoordinates textureCoordinates;
    textureCoordinates.uv = fragmentUv;
    textureCoordinates.dx = vec2(0.0);
    textureCoordinates.dy = vec2(0.0);
    vec4 textureColor = vec4(1.0);
    if (farColorSurface < 0.5) {
        textureCoordinates = resolveTextureCoordinates(
            fragmentUv,
            vec2(textureSize(textures[nonuniformEXT(fragmentTexIndex0.x)], 0))
        );
        textureColor = sampleAlbedo(textureCoordinates);
    }
    // Alpha cutout (foliage / sprites / icons): drop near-transparent texels
    // so the card shows clean transparent edges. Depth-correct, order-free.
    if (hasAlphaClip() > 0.5) {
        if (textureColor.a < 0.5) {
            discard;
        }
    }
    vec3 albedo = fragmentColor * textureColor.rgb;
    if (styleEnabled() && hasWorldPixelSampling() > 0.5 && worldSurfaceEffect() < 0.5) {
        albedo *= styleVariationTint();
    }
    float materialAlpha = float(fragmentTexIndex1.w) / 65535.0;
    vec4 surfaceColor = vec4(albedo, textureColor.a * clamp(materialAlpha, 0.0, 1.0));
    vec3 geometryNormal = normalize(fragmentWorldNormal);
    if (dot(geometryNormal, geometryNormal) < 0.0001) {
        geometryNormal = normalize(cross(dFdx(fragmentWorldPosition), dFdy(fragmentWorldPosition)));
    }
    if (!gl_FrontFacing) {
        geometryNormal = -geometryNormal;
    }
    float geometryRoughness = clamp(fragmentMaterial.y, 0.045, 1.0);

    vec3 cameraPosition = vec3(
        pushConstants.fogShapeProjectionLight.y,
        pushConstants.fogShapeProjectionLight.z,
        pushConstants.fogShapeProjectionLight.w
    );
    vec4 emissive = unpackEmissive();
    float packedLight = max(pushConstants.fogColor.a, 0.0);
    float lightIntensity = max(pushConstants.lightDirectionIntensity.w, 0.0);
    if (fragmentMaterial.x <= -1.0 && emissive.a < 0.5) {
        // Scalar albedo illumination, NOT a glowing unlit material. A game can
        // drive dawn/night or lightmaps without exposing polygon orientation.
        float energy = clamp(-1.0 - fragmentMaterial.x, 0.0, 4.0);
        if (styleEnabled()) {
            vec3 styleLightDirection = pushConstants.lightDirectionIntensity.xyz;
            vec3 styleSunColor = vec3(1.0);
            float styleShadow = 1.0;
            // Double-sided cards (foliage) keep one normal for both faces so
            // their back faces are not turned into shade.
            vec3 styleSurfaceNormal = styleNormal(isDoubleSided() > 0.5 && !gl_FrontFacing ? -geometryNormal : geometryNormal);
            if (packedLight > 0.5 && dot(styleLightDirection, styleLightDirection) > 0.000001) {
                styleLightDirection = normalize(styleLightDirection);
                styleSunColor = unpackLight().rgb;
                styleShadow = sampleShadow(styleSurfaceNormal, styleLightDirection);
            } else {
                styleLightDirection = vec3(0.0);
            }
            if (styleFaces()) {
                surfaceColor.rgb = albedo * energy * skyVisibility() * styleFaceShade(styleSurfaceNormal, styleLocalUp());
            } else {
                surfaceColor.rgb = albedo * styleLightColor(energy * skyVisibility(), styleSurfaceNormal, styleLightDirection, styleShadow, styleSunColor, 1.0);
            }
        } else {
            surfaceColor.rgb = albedo * energy * skyVisibility();
        }
        int pointCount = int(clamp(floor(pointLights.meta.x + 0.5), 0.0, float(MAX_POINT_LIGHTS)));
        for (int index = 0; index < pointCount; index++) {
            vec4 positionRange = pointLights.positionRange[index];
            float distanceToLight = length(positionRange.xyz - fragmentWorldPosition);
            float fill = clamp(1.0 - distanceToLight / max(positionRange.w, 0.0001), 0.0, 1.0);
            vec4 colorEnergy = pointLights.colorEnergy[index];
            surfaceColor.rgb += albedo * colorEnergy.rgb * colorEnergy.a * fill * fill;
        }
    } else if (emissive.a < 0.5) {
        vec3 normal = normalize(fragmentWorldNormal);
        if (dot(normal, normal) < 0.0001) {
            vec3 dx = dFdx(fragmentWorldPosition);
            vec3 dy = dFdy(fragmentWorldPosition);
            normal = normalize(cross(dx, dy));
        }
        if (!gl_FrontFacing) {
            normal = -normal;
        }

        if (farColorSurface < 0.5 && hasNormalMap() > 0.5) {
            vec2 sampledXY = sampleNormalMap(textureCoordinates).xy * 2.0 - 1.0;
            float sampledZ = sqrt(max(1.0 - dot(sampledXY, sampledXY), 0.0));
            vec3 sampledNormal = vec3(sampledXY, sampledZ);
            normal = normalize(normalMapFrame(normal, fragmentWorldPosition, textureCoordinates.uv) * sampledNormal);
        }
        geometryNormal = normal;

        float metallic = clamp(fragmentMaterial.x, 0.0, 1.0);
        float roughness = clamp(fragmentMaterial.y, 0.045, 1.0);
        if (farColorSurface < 0.5 && hasMetallicRoughnessMap() > 0.5) {
            vec4 metallicRoughness = sampleMetallicRoughness(textureCoordinates);
            metallic *= metallicRoughness.b;
            roughness = clamp(roughness * metallicRoughness.g, 0.045, 1.0);
        }
        geometryRoughness = roughness;

        float occlusion = 1.0;
        if (farColorSurface < 0.5 && hasOcclusionMap() > 0.5) {
            occlusion = sampleOcclusion(textureCoordinates).r;
        }

        vec3 viewDirection = normalize(cameraPosition - fragmentWorldPosition);

        vec3 irradiance = vec3(0.0);
        bool hasLight = false;
        bool hasSkyLighting = pointLights.environmentLighting.z > 0.5;
        bool hasVanillaLighting = pointLights.environmentLighting.w > 0.5;
        float skyLight = skyVisibility();
        if (packedLight > 0.5) {
            vec3 lightDirection = normalize(pushConstants.lightDirectionIntensity.xyz);
            vec4 light = unpackLight();
            vec3 styleSurfaceNormal = styleEnabled() ? styleNormal(normal) : normal;
            float shadow = sampleShadow(styleSurfaceNormal, lightDirection);
            if (styleFaces()) {
                // Day energy of a sun-facing classic surface, faded to the
                // ambient floor by this pixel's own sun height.
                vec3 styleUp = styleLocalUp();
                float styleDay = styleDaylight(styleUp, lightDirection);
                float styleEnergy = mix(light.a, light.a + lightIntensity * 0.62, styleDay) * occlusion * skyLight;
                irradiance += albedo * styleEnergy * styleFaceShade(styleSurfaceNormal, styleUp);
            } else if (styleEnabled()) {
                float styleEnergy = (light.a + lightIntensity * 0.62) * occlusion * skyLight;
                vec3 styleColor = styleLightColor(styleEnergy, styleSurfaceNormal, lightDirection, shadow, light.rgb, styleSkyLevel(styleSurfaceNormal));
                irradiance += albedo * max(styleColor, vec3(light.a * occlusion * skyLight));
            } else {
                vec3 directionalRadiance = light.rgb * lightIntensity * shadow;
                irradiance += albedo * light.a * occlusion * skyLight;
                if (hasVanillaLighting) {
                    float normalLight = max(dot(normal, -lightDirection), 0.0);
                    irradiance += albedo * directionalRadiance * normalLight * 0.62 * occlusion * skyLight;
                } else {
                    irradiance += evaluatePbrLight(normal, viewDirection, -lightDirection, albedo, metallic, roughness, directionalRadiance) * skyLight;
                }
            }
            hasLight = true;
        }

        if (hasSkyLighting) {
            if (hasVanillaLighting) {
                irradiance += albedo * sampleSkyLighting(normal) * pointLights.environmentLighting.x * occlusion * skyLight;
            } else {
                irradiance += evaluateSkyLighting(normal, viewDirection, albedo, metallic, roughness) * occlusion * skyLight;
            }
            hasLight = true;
        }

        int pointCount = int(clamp(floor(pointLights.meta.x + 0.5), 0.0, float(MAX_POINT_LIGHTS)));
        for (int index = 0; index < pointCount; index++) {
            vec4 pointPositionRange = pointLights.positionRange[index];
            vec4 pointColorEnergy = pointLights.colorEnergy[index];
            vec3 delta = pointPositionRange.xyz - fragmentWorldPosition;
            float distanceToLight = length(delta);
            float lightRange = max(pointPositionRange.w, 0.0001);
            if (distanceToLight < lightRange) {
                vec3 pointDirection = delta / max(distanceToLight, 0.0001);
                float normalizedDistance = clamp(1.0 - distanceToLight / lightRange, 0.0, 1.0);
                float attenuation = normalizedDistance * normalizedDistance;
                vec3 pointRadiance = pointColorEnergy.rgb * pointColorEnergy.a * attenuation;
                if (hasVanillaLighting) {
                    float normalPoint = max(dot(normal, pointDirection), 0.0);
                    irradiance += albedo * pointRadiance * normalPoint * occlusion;
                } else {
                    irradiance += evaluatePbrLight(normal, viewDirection, pointDirection, albedo, metallic, roughness, pointRadiance);
                }
                hasLight = true;
            }
        }

        if (hasLight) {
            surfaceColor.rgb = irradiance;
        }
    }
    if (worldSurfaceEffect() > 0.5) {
        vec3 viewDirection = normalize(cameraPosition - fragmentWorldPosition);
        float fresnel = pow(1.0 - abs(dot(geometryNormal, viewDirection)), 4.0);
        vec3 reflectedSky = sampleSkyLighting(reflect(-viewDirection, geometryNormal));
        vec3 clearWater = surfaceColor.rgb * vec3(0.78, 0.92, 1.06);
        surfaceColor.rgb = mix(clearWater, reflectedSky * 0.58 + clearWater * 0.42, 0.14 + fresnel * 0.34);
        surfaceColor.a = mix(surfaceColor.a, 0.86, fresnel * 0.55);
    }
    vec3 emissiveColor = emissive.rgb;
    if (farColorSurface < 0.5 && hasEmissiveMap() > 0.5) {
        vec4 emissiveTexel = sampleEmissive(textureCoordinates);
        emissiveColor *= emissiveTexel.rgb * emissiveTexel.a;
    }
    surfaceColor.rgb += emissiveColor * max(fragmentMaterial.z, 0.0);

    if (styleEnabled()) {
        surfaceColor.rgb = styleGradeColor(surfaceColor.rgb);
    }

    float fogFactor = 0.0;
    int fogMode = int(pushConstants.fogParams.x + 0.5);
    float fogStart = pushConstants.fogParams.y;
    float fogEnd = pushConstants.fogParams.z;
    float fogDensity = max(pushConstants.fogParams.w, 0.0);

    float fogDistance = fogDistanceForFragment();
    // Per-mesh fog distance scale, texIndex1.z as float bits (0 = default).
    float fogDistanceScale = uintBitsToFloat(fragmentTexIndex1.z);
    if (fogDistanceScale > 0.0) {
        fogDistance = fogDistance / fogDistanceScale;
    }

    if (fogMode == 5) {
        fogFactor = smoothstep(fogStart, max(fogEnd, fogStart + 0.0001), fogDistance)
            * clamp(fogDensity, 0.0, 1.0);
    } else if (fogMode == 1 || fogMode == 4) {
        float fogRange = max(fogEnd - fogStart, 0.0001);
        fogFactor = clamp((fogDistance - fogStart) / fogRange, 0.0, 1.0);
    } else if (fogMode == 2) {
        fogFactor = 1.0 - exp(-fogDensity * fogDistance);
    } else if (fogMode == 3) {
        float scaledDistance = fogDensity * fogDistance;
        fogFactor = 1.0 - exp(-(scaledDistance * scaledDistance));
    }

    vec3 resolvedFogColor = pushConstants.fogColor.rgb;
    if (fogMode == 5 && fogFactor > 0.0 && pointLights.skyUpCurve.w > 0.0) {
        resolvedFogColor = evaluateSkyGradient(fragmentWorldPosition - cameraPosition,
            pointLights.skyUpCurve.xyz, pointLights.skyZenith.rgb, pointLights.skyHorizon.rgb,
            pointLights.skyLower.rgb, pointLights.skyUpCurve.w, pointLights.horizonGlowDirection.xyz,
            pointLights.horizonGlowColor.rgb, pointLights.horizonGlowDirection.w, pointLights.horizonGlowColor.w);
    }
    if (fogMode == 4) {
        vec3 cameraToFragment = fragmentWorldPosition - cameraPosition;
        float rayLength = max(fogDistance, 0.0001);
        vec3 rayDirection = cameraToFragment / rayLength;
        float intensity = fogDensity;

        // Keep the atmosphere analytic: a horizon-weighted distance term plus
        // a restrained camera-relative height term, with zero extra samples.
        float horizonWeight = 1.0 - smoothstep(0.055, 0.58, abs(rayDirection.y));
        float aerialStart = max(fogStart * 0.24, 12.0);
        float aerialEnd = max(fogStart * 0.92, aerialStart + 1.0);
        float aerialDistance = smoothstep(aerialStart, aerialEnd, fogDistance);
        float aerialHaze = horizonWeight * aerialDistance * intensity * 0.43;

        float heightScale = max(fogEnd * 0.11, 8.0);
        float belowCamera = clamp((cameraPosition.y - fragmentWorldPosition.y) / heightScale, 0.0, 1.0);
        float heightDistance = smoothstep(max(fogStart * 0.30, 16.0), max(fogEnd * 0.78, 17.0), fogDistance);
        float heightHaze = belowCamera * heightDistance * intensity * 0.20;

        fogFactor = 1.0 - (1.0 - fogFactor)
            * (1.0 - clamp(aerialHaze, 0.0, 0.82))
            * (1.0 - clamp(heightHaze, 0.0, 0.42));

        float skyUp = smoothstep(0.0, 0.72, max(rayDirection.y, 0.0));
        float skyDown = smoothstep(0.0, 0.55, max(-rayDirection.y, 0.0));
        vec3 skyFogColor = mix(pointLights.skyHorizon.rgb, pointLights.skyZenith.rgb, skyUp);
        skyFogColor = mix(skyFogColor, pointLights.skyLower.rgb, skyDown);
        resolvedFogColor = mix(pushConstants.fogColor.rgb, skyFogColor, 0.86);
    }

    fogFactor = clamp(fogFactor, 0.0, 1.0);
    outColor = vec4(
        mix(surfaceColor.rgb, resolvedFogColor, fogFactor),
        surfaceColor.a
    );
    outGeometry = vec4(geometryNormal * 0.5 + 0.5, geometryRoughness);
}
