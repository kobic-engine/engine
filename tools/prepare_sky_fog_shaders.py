#!/usr/bin/env python3
"""Compile/validate ONLY the three sky/fog fragment shaders and embed atomically.

No Dolet compiler, game build, vertex shader, or other embedded shader is run
or changed. The existing regen_shader.emit_block authoring format is reused.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile


PACKAGE = Path(__file__).resolve().parents[1]
SOURCES = PACKAGE / "render" / "shaders"
TARGET = PACKAGE / "render" / "gpu_shaders.dlt"
ARTIFACTS = PACKAGE / ".build" / "sky-fog"
MANIFEST = ARTIFACTS / "manifest.json"
SHADERS = (
    ("sky.frag", "sky_frag", "get_sky_frag_shader"),
    ("textured.frag", "tex_frag", "get_textured_frag_shader"),
    ("textured_bindless.frag", "tex_bindless_frag", "get_textured_bindless_frag_shader"),
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def block_pattern(name: str) -> str:
    return (re.escape(f"# >>> EMBED {name} BEGIN") + r".*?" +
            re.escape(f"# <<< EMBED {name} END"))


def strip_selected(text: str) -> str:
    for _, name, _ in SHADERS:
        text, count = re.subn(block_pattern(name), "", text, flags=re.S)
        if count != 1:
            raise RuntimeError(f"Expected exactly one marked {name} block; got {count}")
    return text


def find_tool(name: str, explicit: str | None, neighbour: Path | None = None) -> Path:
    if explicit:
        found = Path(explicit).expanduser().resolve()
        if not found.is_file():
            raise RuntimeError(f"Tool does not exist: {found}")
        return found
    names = (name + ".exe", name) if os.name == "nt" else (name,)
    candidates: list[Path] = []
    if neighbour:
        candidates.extend(neighbour.parent / filename for filename in names)
    sdk = os.environ.get("VULKAN_SDK")
    if sdk:
        candidates.extend(Path(sdk) / folder / filename
                          for folder in ("Bin", "bin") for filename in names)
    for filename in names:
        system_path = shutil.which(filename)
        if system_path:
            candidates.append(Path(system_path))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(f"Cannot find {name}; install Vulkan SDK or supply --{name}")


def validate_header(data: bytes, label: str) -> None:
    if len(data) < 20 or len(data) % 4:
        raise RuntimeError(f"Invalid SPIR-V byte size: {label}")
    magic, version, _, bound, reserved = struct.unpack_from("<5I", data)
    if magic != 0x07230203 or not (0x00010000 <= version <= 0x00010600) or not bound or reserved:
        raise RuntimeError(f"Invalid SPIR-V header: {label}")
    words = struct.unpack(f"<{len(data) // 4}I", data)
    offset = 5
    while offset < len(words):
        count = words[offset] >> 16
        if not count or offset + count > len(words):
            raise RuntimeError(f"Invalid SPIR-V instruction stream: {label}")
        offset += count


def run(command: list[str]) -> None:
    result = subprocess.run(command, text=True, capture_output=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"Tool exited {result.returncode}: {command[0]}")


def check_only() -> None:
    if not MANIFEST.is_file():
        raise RuntimeError("No sky/fog shader manifest yet; regeneration has not been completed")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    target_text = TARGET.read_bytes().decode("utf-8")
    for filename, name, _ in SHADERS:
        entry = manifest["shaders"][filename]
        if sha((SOURCES / filename).read_bytes()) != entry["source_sha256"]:
            raise RuntimeError(f"Source changed after shader regeneration: {filename}")
        match = re.search(block_pattern(name), target_text, flags=re.S)
        if match is None or sha(match.group(0).encode("utf-8")) != entry["embedded_block_sha256"]:
            raise RuntimeError(f"Embedded shader does not match validated manifest: {name}")
    print("PASS: all three source hashes match their validated embedded blocks")


def regenerate(args: argparse.Namespace) -> None:
    validator = find_tool("glslangValidator", args.glslang_validator)
    spirv_val = find_tool("spirv-val", args.spirv_val, validator)
    generator_spec = importlib.util.spec_from_file_location("kobic_shader_generator", PACKAGE / "tools" / "regen_shader.py")
    if generator_spec is None or generator_spec.loader is None:
        raise RuntimeError("Cannot load existing regen_shader.py")
    generator = importlib.util.module_from_spec(generator_spec)
    generator_spec.loader.exec_module(generator)
    before = TARGET.read_bytes()
    before_text = before.decode("utf-8")
    untouched = strip_selected(before_text)
    newline = "\r\n" if b"\r\n" in before else "\n"
    pending = before_text
    manifest: dict = {"target_environment": args.target_env, "shaders": {}}
    binaries: dict[str, bytes] = {}
    with tempfile.TemporaryDirectory(prefix="kobic-sky-fog-") as temp_dir:
        for filename, name, getter in SHADERS:
            output = Path(temp_dir) / (filename + ".spv")
            source_bytes = (SOURCES / filename).read_bytes()
            run([str(validator), "-V", "--target-env", args.target_env, "-Os",
                 str(SOURCES / filename), "-o", str(output)])
            binary = output.read_bytes()
            validate_header(binary, filename)
            run([str(spirv_val), "--target-env", args.target_env, str(output)])
            # Import the existing generator, but replace only the exact marked
            # block; its unrelated legacy migrations must not run here.
            block = generator.emit_block(output, name, getter).replace("\n", newline)
            pending, count = re.subn(block_pattern(name), lambda _: block, pending, flags=re.S)
            if count != 1 or pending.count(f"fun {getter}()") != 1:
                raise RuntimeError(f"Incomplete or duplicate embed block: {name}")
            binaries[filename] = binary
            manifest["shaders"][filename] = {
                "source_sha256": sha(source_bytes), "spirv_sha256": sha(binary),
                "spirv_bytes": len(binary), "embedded_block_sha256": sha(block.encode("utf-8")),
            }
        if strip_selected(pending) != untouched:
            raise RuntimeError("Refusing to change content outside the three fragment blocks")
        if TARGET.read_bytes() != before:
            raise RuntimeError("gpu_shaders.dlt changed during preparation; retry without concurrent edits")
        for filename, _, _ in SHADERS:
            if sha((SOURCES / filename).read_bytes()) != manifest["shaders"][filename]["source_sha256"]:
                raise RuntimeError(f"Source changed during shader preparation: {filename}")
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        backup = ARTIFACTS / ("gpu_shaders.before-" + sha(before)[:12] + ".dlt")
        if not backup.exists():
            backup.write_bytes(before)
        staged: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(prefix="gpu_shaders.sky-fog-", suffix=".tmp",
                                             dir=TARGET.parent, delete=False) as handle:
                staged = Path(handle.name)
                handle.write(pending.encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(staged, TARGET)
            staged = None
        finally:
            if staged is not None:
                staged.unlink(missing_ok=True)
        for filename, binary in binaries.items():
            (ARTIFACTS / (filename + ".spv")).write_bytes(binary)
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("PASS: compiled, spirv-val validated, and atomically embedded only 3 fragment shaders")
    print(f"Recoverable previous embedding: {backup}")
    check_only()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--glslang-validator", help="Path to glslangValidator executable")
    parser.add_argument("--spirv-val", help="Path to spirv-val executable")
    parser.add_argument("--target-env", default="vulkan1.0")
    parser.add_argument("--check-only", action="store_true", help="Verify cached source/embedded hashes; compile nothing")
    args = parser.parse_args()
    try:
        check_only() if args.check_only else regenerate(args)
    except (RuntimeError, OSError) as error:
        parser.exit(1, f"[sky-fog] {error}\n")


if __name__ == "__main__":
    main()
