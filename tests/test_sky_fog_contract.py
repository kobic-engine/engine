"""Read-only source/numerical/compiled-SPIR-V contract checks (no game).

Run from any directory with Python's standard library. Shader reflection is
checked if the three validated outputs from prepare_sky_fog_shaders exist.
"""
from __future__ import annotations

import math
from pathlib import Path
import random
import re
import struct
import unittest


PACKAGE = Path(__file__).resolve().parents[1]
SHADERS = PACKAGE / "render" / "shaders"


def glsl_function(text: str, name: str) -> str:
    found = re.search(r"\b" + re.escape(name) + r"\([^;{}]*\)\s*\{", text)
    assert found is not None, name
    cursor, depth = found.end(), 1
    while depth:
        depth += (text[cursor] == "{") - (text[cursor] == "}")
        cursor += 1
    return text[found.start():cursor]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def normalize(a):
    scale = math.sqrt(max(dot(a, a), 0.000001))
    return tuple(x / scale for x in a)


def smoothstep(a, b, value):
    t = min(max((value - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def mix(a, b, blend):
    return tuple(x * (1 - blend) + y * blend for x, y in zip(a, b))


def gradient(ray, up, zenith, horizon, lower, curve, glow_dir, glow, strength, extent):
    ray = normalize(ray)
    vertical = min(max(dot(ray, up), -1.0), 1.0)
    blend = abs(vertical) ** min(max(curve, 0.20), 4.0)
    color = mix(horizon, zenith if vertical >= 0 else lower, blend)
    if strength <= 0:
        return color
    ray_horizontal = tuple(r - u * vertical for r, u in zip(ray, up))
    glow_vertical = dot(glow_dir, up)
    glow_horizontal = tuple(g - u * glow_vertical for g, u in zip(glow_dir, up))
    alignment = max(dot(normalize(ray_horizontal), normalize(glow_horizontal)), 0.0) ** 2
    band = 1 - smoothstep(0, min(max(extent, 0.05), 1.0), abs(vertical))
    return mix(color, glow, min(max(strength, 0), 1) * alignment * band)


def up_basis(up):
    guide = (1.0, 0.0, 0.0) if abs(up[2]) > 0.95 else (0.0, 0.0, 1.0)
    right = normalize(cross(up, guide))
    return right, up, cross(right, up)


def transform_into_basis(ray, basis):
    return tuple(dot(ray, column) for column in basis)


class SkyFogContract(unittest.TestCase):
    def setUp(self):
        self.sky = (SHADERS / "sky.frag").read_text(encoding="utf-8")
        self.mesh = [(SHADERS / filename).read_text(encoding="utf-8")
                     for filename in ("textured.frag", "textured_bindless.frag")]
        self.core = (PACKAGE / "render" / "gpu_renderer_core.dlt").read_text(encoding="utf-8")
        self.env = (PACKAGE / "scene" / "environment.dlt").read_text(encoding="utf-8")

    def test_identical_direction_evaluator(self):
        helper = glsl_function(self.sky, "evaluateSkyGradient")
        for mesh in self.mesh:
            self.assertEqual(helper, glsl_function(mesh, "evaluateSkyGradient"))
            self.assertIn("fogMode == 5 && fogFactor > 0.0 && pointLights.skyUpCurve.w > 0.0", mesh)
            self.assertIn("smoothstep(fogStart, max(fogEnd, fogStart + 0.0001), fogDistance)", mesh)
            self.assertIn("* clamp(fogDensity, 0.0, 1.0)", mesh)
        self.assertNotIn("texture(", helper)
        self.assertNotIn("acos(", helper)
        self.assertNotIn("exp(", helper)
        self.assertIn("gradientPower != 1.0", helper)

    def test_std140_prefix_and_extension(self):
        expected = ["meta", "positionRange", "colorEnergy", "skyZenith", "skyHorizon", "skyLower",
                    "environmentLighting", "skyUpCurve", "horizonGlowDirection", "horizonGlowColor"]
        offsets = [0, 16, 144, 272, 288, 304, 320, 336, 352, 368]
        for mesh in self.mesh:
            block = re.search(r"uniform PointLightBlock\s*\{(.*?)\}", mesh, re.S).group(1)
            declarations = re.findall(r"vec4\s+(\w+)(\[MAX_POINT_LIGHTS\])?\s*;", block)
            self.assertEqual([name for name, _ in declarations], expected)
            cursor, actual = 0, []
            for _, array in declarations:
                actual.append(cursor)
                cursor += 128 if array else 16
            self.assertEqual(actual, offsets)
            self.assertEqual(cursor, 384)
        self.assertIn("KOBIC_POINT_LIGHT_DATA_SIZE: i64 = 384", self.core)
        for offset in range(336, 384, 4):
            self.assertIn(f"Memory.write_f32(out + {offset},", self.core)
        sky_gate = self.core.index("if env.sky.enabled() == 1:", self.core.index("fun _write_point_light_data"))
        lighting_gate = self.core.index("if env.lighting.enabled == 1:", sky_gate)
        self.assertLess(self.core.index("Memory.write_f32(out + 348,", sky_gate), lighting_gate)

    def test_original_defaults_and_no_sky_fallback(self):
        self.assertIn("gradient_power: f32 = 1.0", self.env)
        self.assertIn("horizon_glow_strength: f32 = 0.0", self.env)
        self.assertIn("imm FOG_MODE_SKY: i32 = 5", self.env)
        self.assertIn("fog.shape = FOG_SHAPE_SPHERICAL", self.env)
        self.assertIn("fog.density = clamp(strength, 0.0, 1.0)", self.env)
        for mesh in self.mesh:
            self.assertIn("vec3 resolvedFogColor = pushConstants.fogColor.rgb", mesh)
            self.assertIn("fogMode == 1 || fogMode == 4", mesh)
            self.assertIn("1.0 - exp(-fogDensity * fogDistance)", mesh)
            self.assertIn("1.0 - exp(-(scaledDistance * scaledDistance))", mesh)
        rng = random.Random(842)
        for _ in range(1000):
            ray = normalize(tuple(rng.uniform(-1, 1) for _ in range(3)))
            colors = [tuple(rng.random() for _ in range(3)) for _ in range(3)]
            zenith, horizon, lower = colors
            legacy = mix(horizon, zenith if ray[1] >= 0 else lower, abs(ray[1]))
            actual = gradient(ray, (0, 1, 0), *colors, 1, (0, 0, 1), (1, 0.4, 0.05), 0, 0.36)
            self.assertLess(max(abs(a - b) for a, b in zip(actual, legacy)), 1e-14)

    def test_sky_fog_color_same_for_planet_and_camera_frames(self):
        rng = random.Random(7391)
        colors = ((0.02, 0.04, 0.09), (0.15, 0.20, 0.31), (0.07, 0.11, 0.19))
        glow = (0.86, 0.32, 0.045)
        # World-space fog and up-aligned sky must agree for every viewing ray;
        # a camera rotation cancels as transpose(C*B)*(C*ray) = transpose(B)*ray.
        for _ in range(2000):
            up = normalize(tuple(rng.uniform(-1, 1) for _ in range(3)))
            ray = normalize(tuple(rng.uniform(-1, 1) for _ in range(3)))
            sun = normalize(tuple(rng.uniform(-1, 1) for _ in range(3)))
            basis = up_basis(up)
            fog_color = gradient(ray, up, *colors, 0.55, sun, glow, 0.94, 0.36)
            sky_color = gradient(transform_into_basis(ray, basis), (0, 1, 0), *colors, 0.55,
                                 transform_into_basis(sun, basis), glow, 0.94, 0.36)
            self.assertLess(max(abs(a - b) for a, b in zip(fog_color, sky_color)), 2e-12)

    def test_glow_and_finite_distance_are_bounded_and_smooth(self):
        colors = ((0.03, 0.05, 0.10), (0.1, 0.15, 0.2), (0.04, 0.06, 0.09))
        glow = (0.90, 0.40, 0.05)
        forward = gradient((0, 0, 1), (0, 1, 0), *colors, 0.55, (0, 0, 1), glow, 1, 0.36)
        backward = gradient((0, 0, -1), (0, 1, 0), *colors, 0.55, (0, 0, 1), glow, 1, 0.36)
        self.assertEqual(forward, glow)
        self.assertEqual(backward, colors[1])
        for ray in ((0, 1, 0), (0, -1, 0), (0, 0, 0)):
            result = gradient(ray, (0, 1, 0), *colors, 0.55, (0, 0, 1), glow, 1, 0.36)
            self.assertTrue(all(math.isfinite(v) and 0 <= v <= 1 for v in result))
        factors = [smoothstep(64, 560, distance) for distance in range(0, 701)]
        self.assertEqual(factors[64], 0)
        self.assertEqual(factors[560], 1)
        self.assertTrue(all(a <= b for a, b in zip(factors, factors[1:])))
        self.assertLess(factors[65], 0.0001)
        self.assertLess(1 - factors[559], 0.0001)

    def test_compiled_material_ubo_offsets_if_available(self):
        for filename in ("textured.frag.spv", "textured_bindless.frag.spv"):
            path = PACKAGE / ".build" / "sky-fog" / filename
            if not path.exists():
                self.skipTest("Validated SPIR-V cache is not present; source checks still run")
            data = path.read_bytes()
            words = struct.unpack(f"<{len(data) // 4}I", data)
            names, offsets = {}, {}
            cursor = 5
            while cursor < len(words):
                instruction = words[cursor]
                count, opcode = instruction >> 16, instruction & 0xFFFF
                operands = words[cursor + 1:cursor + count]
                if opcode == 5:  # OpName
                    encoded = struct.pack(f"<{len(operands) - 1}I", *operands[1:])
                    names[operands[0]] = encoded.split(b"\0")[0].decode("utf-8")
                elif opcode == 72 and operands[2] == 35:  # OpMemberDecorate Offset
                    offsets[(operands[0], operands[1])] = operands[3]
                cursor += count
            block_id = next(key for key, value in names.items() if value == "PointLightBlock")
            self.assertEqual([offsets[(block_id, i)] for i in range(10)],
                             [0, 16, 144, 272, 288, 304, 320, 336, 352, 368])


if __name__ == "__main__":
    unittest.main(verbosity=2)
