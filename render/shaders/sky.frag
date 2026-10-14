#version 450

layout(location = 0) out vec4 outColor;

layout(set = 0, binding = 0) uniform sampler2D skyTexture;

layout(push_constant) uniform SkyPushConstants {
    mat4 view;
    vec4 zenithColor;
    vec4 horizonColor;
    vec4 lowerColor;
    vec4 projectionAndSize;
} sky;

float gradientNoise(vec2 position) {
    return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715))));
}

vec2 skyObjectUv(vec3 worldDirection, vec3 objectDirection, float radius) {
    vec3 guide = abs(objectDirection.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(guide, objectDirection));
    vec3 up = normalize(cross(objectDirection, right));
    float scale = max(tan(max(radius, 0.001)), 0.0001);
    return vec2(dot(worldDirection, right), dot(worldDirection, up)) / scale * 0.5 + 0.5;
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

void main() {
    vec2 size = max(sky.projectionAndSize.zw, vec2(1.0));
    vec2 ndc = (gl_FragCoord.xy / size) * 2.0 - 1.0;
    float projectionX = max(abs(sky.projectionAndSize.x), 0.0001);
    float projectionY = sky.projectionAndSize.y;
    if (abs(projectionY) < 0.0001) {
        projectionY = -0.0001;
    }

    vec3 viewDirection = normalize(vec3(
        ndc.x / projectionX,
        ndc.y / projectionY,
        -1.0
    ));
    vec3 worldDirection = normalize(transpose(mat3(sky.view)) * viewDirection);

    float worldY = clamp(worldDirection.y, -1.0, 1.0);
    vec3 color;
    if (worldY >= 0.0) {
        color = mix(sky.horizonColor.rgb, sky.zenithColor.rgb, worldY);
    } else {
        color = mix(sky.horizonColor.rgb, sky.lowerColor.rgb, -worldY);
    }

    float objectMode = sky.view[3][3];
    if (objectMode < 0.5) {
        color = evaluateSkyGradient(worldDirection, vec3(0.0, 1.0, 0.0),
            sky.zenithColor.rgb, sky.horizonColor.rgb, sky.lowerColor.rgb,
            sky.zenithColor.a, vec3(sky.view[0][3], sky.view[1][3], sky.view[2][3]),
            sky.view[3].xyz, sky.horizonColor.a, sky.lowerColor.a);
    }
    if (objectMode > 3.5) {
        if (worldY <= 0.025) {
            discard;
        }
        float scale = max(abs(sky.view[2][3]), 0.02);
        vec2 plane = worldDirection.xz / max(worldY, 0.055);
        vec2 cloudUv = plane * scale + vec2(sky.view[0][3], sky.view[1][3]);
        vec2 cloudCell = floor(cloudUv);
        vec2 macroCell = floor(cloudCell / 8.0);
        vec2 localCell = cloudCell - macroCell * 8.0 + vec2(0.5);
        float cloudSeed = gradientNoise(macroCell);
        float shapeSeed = gradientNoise(macroCell + vec2(19.0, 47.0));
        vec2 center = vec2(
            2.4 + shapeSeed * 3.2,
            2.6 + fract(cloudSeed + shapeSeed) * 2.8
        );
        vec2 halfSize = vec2(
            1.6 + cloudSeed * 1.8,
            0.9 + shapeSeed * 1.25
        );
        vec2 rectangleDistance = abs(localCell - center) - halfSize;
        float rectangle = 1.0 - step(0.01, max(rectangleDistance.x, rectangleDistance.y));
        float coverage = clamp(sky.horizonColor.a, 0.05, 0.95);
        float softness = clamp(sky.lowerColor.a, 0.005, 0.40);
        float occupied = smoothstep(coverage - softness, coverage + softness, cloudSeed);
        float cloudAlpha = rectangle * occupied;
        float horizonFade = smoothstep(0.025, 0.18, worldY);
        cloudAlpha *= clamp(sky.zenithColor.a, 0.0, 1.0) * horizonFade;
        if (cloudAlpha <= 0.004) {
            discard;
        }
        outColor = vec4(clamp(sky.view[3].xyz, 0.0, 1.0), cloudAlpha);
        return;
    }

    if (objectMode > 2.5) {
        vec3 objectDirection = normalize(vec3(sky.view[0][3], sky.view[1][3], sky.view[2][3]));
        vec3 objectColor = sky.view[3].xyz;
        float cosAngle = clamp(dot(worldDirection, objectDirection), -1.0, 1.0);
        float angle = acos(cosAngle);
        float radius = max(sky.zenithColor.a, 0.001);
        float glow = clamp(sky.horizonColor.a, 0.0, 1.0);
        float softness = clamp(sky.lowerColor.a, 0.0, 1.0);
        float aa = max(fwidth(angle), 0.0006);
        float glowRadius = max(radius + aa * 2.0, radius * (2.0 + glow * 4.0));
        float edgeSoftness = mix(aa * 1.5, max(radius * 0.45, aa * 2.5), softness);

        float disc = 1.0 - smoothstep(radius - edgeSoftness, radius + edgeSoftness, angle);
        float halo = 1.0 - smoothstep(radius, glowRadius, angle);
        halo = halo * halo * glow;
        float alpha = max(disc, halo * 0.35);
        if (alpha <= 0.002) {
            discard;
        }
        outColor = vec4(clamp(objectColor, 0.0, 1.0), clamp(alpha, 0.0, 1.0));
        return;
    }

    if (objectMode > 1.5) {
        vec3 objectDirection = normalize(vec3(sky.view[0][3], sky.view[1][3], sky.view[2][3]));
        float radius = max(sky.zenithColor.a, 0.001);
        float textureScale = max(sky.horizonColor.a, 0.05);
        float textureRadius = radius * textureScale;
        float cosAngle = clamp(dot(worldDirection, objectDirection), -1.0, 1.0);
        if (acos(cosAngle) > textureRadius * 1.45) {
            discard;
        }
        vec2 uv = skyObjectUv(worldDirection, objectDirection, textureRadius);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            discard;
        }
        vec4 texel = texture(skyTexture, uv);
        float key = max(max(texel.r, texel.g), texel.b);
        float keyedAlpha = smoothstep(0.004, 0.040, key);
        float alpha = texel.a * keyedAlpha;
        if (alpha <= 0.01) {
            discard;
        }
        vec3 tint = sky.view[3].xyz;
        outColor = vec4(clamp(texel.rgb * tint, 0.0, 1.0), alpha);
        return;
    }

    if (objectMode > 0.5) {
        vec3 sunDirection = normalize(vec3(sky.view[0][3], sky.view[1][3], sky.view[2][3]));
        vec3 sunColor = sky.view[3].xyz;
        float cosAngle = clamp(dot(worldDirection, sunDirection), -1.0, 1.0);
        float angle = acos(cosAngle);
        float radius = max(sky.zenithColor.a, 0.001);
        float glow = clamp(sky.horizonColor.a, 0.0, 1.0);
        float softness = clamp(sky.lowerColor.a, 0.0, 1.0);
        float glowRadius = radius * (2.0 + glow * 4.0);
        float aa = max(fwidth(angle), 0.0006);
        float edgeSoftness = mix(aa * 1.5, max(radius * 0.45, aa * 2.5), softness);

        float disc = 1.0 - smoothstep(radius - edgeSoftness, radius + edgeSoftness, angle);
        float halo = 1.0 - smoothstep(radius, glowRadius, angle);
        halo = halo * halo * glow;

        color = mix(color, sunColor, halo * 0.35);
        color = mix(color, sunColor, disc);
    }

    float dither = (gradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;
    outColor = vec4(clamp(color + vec3(dither), 0.0, 1.0), 1.0);
}
