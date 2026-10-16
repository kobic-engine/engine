#!/usr/bin/env python3
"""Regenerate a single embedded shader block in gpu_shaders.dlt from a .spv.

Compiles nothing — takes an existing .spv and rewrites (or appends) the
`_kobic_init_<name>_shader_pN` part functions plus the `get_<getter>()`
function, matching the embedding style already used in gpu_shaders.dlt.

The block for a shader is delimited by markers we insert:
    # >>> EMBED <name> BEGIN
    ... generated code ...
    # <<< EMBED <name> END

Usage:
  python regen_shader.py <spv_path> <name> <getter_name> [--file gpu_shaders.dlt]

  <name>       short id used in the part-fn names, e.g. "bindless_frag"
  <getter_name> full getter, e.g. "get_bindless_frag_shader"

If the markers already exist in the target file the block is replaced
in place; otherwise it is appended at end of file.
"""
import sys, struct, os

WRITES_PER_PART = 120  # keep generated Dolet functions small and fast to compile


def emit_block(spv_path, name, getter):
    with open(spv_path, "rb") as f:
        data = f.read()
    if len(data) % 4 != 0:
        raise SystemExit(f"{spv_path}: length {len(data)} not multiple of 4")
    words = struct.unpack("<%dI" % (len(data) // 4), data)

    lines = []
    lines.append(f"# >>> EMBED {name} BEGIN")
    lines.append(f"# Generated from {os.path.basename(spv_path)}: "
                 f"{len(data)} bytes ({len(words)} i32 words). Do not edit by hand.")

    part_count = (len(words) + WRITES_PER_PART - 1) // WRITES_PER_PART
    for p in range(part_count):
        lines.append(f"fun _kobic_init_{name}_shader_p{p}(buf: i64) -> void:")
        start = p * WRITES_PER_PART
        end = min(start + WRITES_PER_PART, len(words))
        for i in range(start, end):
            w = words[i]
            sw = w if w < 0x80000000 else w - 0x100000000
            lines.append(f"    Memory.write_i32(buf + {i * 4}, {sw})")
        lines.append("")

    # dispatcher init that calls every part
    lines.append(f"fun _kobic_init_{name}_shader(buf: i64) -> void:")
    for p in range(part_count):
        lines.append(f"    _kobic_init_{name}_shader_p{p}(buf)")
    lines.append("")

    lines.append(f"fun {getter}() -> EmbeddedShader:")
    lines.append("    shader: EmbeddedShader = EmbeddedShader()")
    lines.append(f"    buf: i64 = Memory.malloc_zeroed({len(data)})")
    lines.append("    if buf == 0:")
    lines.append("        return shader")
    lines.append(f"    _kobic_init_{name}_shader(buf)")
    lines.append("    shader.data = buf")
    lines.append(f"    shader.size = {len(data)}")
    lines.append("    return shader")
    lines.append(f"# <<< EMBED {name} END")
    return "\n".join(lines)


def main():
    spv_path = sys.argv[1]
    name = sys.argv[2]
    getter = sys.argv[3]
    target = "gpu_shaders.dlt"
    if "--file" in sys.argv:
        target = sys.argv[sys.argv.index("--file") + 1]

    block = emit_block(spv_path, name, getter)
    begin = f"# >>> EMBED {name} BEGIN"
    end = f"# <<< EMBED {name} END"

    with open(target, "r", encoding="utf-8") as f:
        src = f.read()

    # Older generated files predate the EMBED markers. Migrate that legacy
    # block in place instead of appending a second copy of the getter and all
    # SPIR-V writes (which can also push Dolet over its token limit).
    legacy_begin = f"fun _kobic_init_{name}_shader_p0"
    marker_pos = src.find(begin)
    legacy_pos = src.find(legacy_begin)
    if legacy_pos >= 0 and (marker_pos < 0 or legacy_pos < marker_pos):
        getter_pos = src.find(f"fun {getter}()", legacy_pos)
        next_fun = src.find("\nfun ", getter_pos + 1)
        if getter_pos < 0 or next_fun < 0:
            raise SystemExit(f"could not locate complete legacy block for {name}")
        src = src[:legacy_pos] + src[next_fun + 1:]

    # `bindless_frag` was an early name for the textured bindless fragment
    # shader. Keeping both embedded copies wastes tens of thousands of Dolet
    # tokens and can overflow the compiler even though the old getter is never
    # referenced. Remove that obsolete generated block during migration.
    if name == "tex_bindless_frag" and getter == "get_textured_bindless_frag_shader":
        obsolete_begin = "# >>> EMBED bindless_frag BEGIN"
        obsolete_end = "# <<< EMBED bindless_frag END"
        if obsolete_begin in src and obsolete_end in src:
            obsolete_start = src.index(obsolete_begin)
            obsolete_stop = src.index(obsolete_end, obsolete_start) + len(obsolete_end)
            src = src[:obsolete_start].rstrip() + "\n\n" + src[obsolete_stop:].lstrip()
        # Old vertex getter spellings are not used by the renderer. Preserve
        # them as aliases instead of embedding duplicate, stale SPIR-V blobs.
        # This also leaves room for new material branches under Dolet's fixed
        # token budget, without changing the renderer's active vertex shaders.
        for old_name, old_getter, active_getter in (
            ("bindless_vert", "get_bindless_vert_shader", "get_textured_bindless_vert_shader"),
            ("bindless_ssbo_vert", "get_bindless_ssbo_vert_shader", "get_textured_bindless_ssbo_vert_shader"),
        ):
            old_begin = f"# >>> EMBED {old_name} BEGIN"
            old_end = f"# <<< EMBED {old_name} END"
            if old_begin in src and old_end in src:
                start = src.index(old_begin)
                stop = src.index(old_end, start) + len(old_end)
                alias = (f"# Compatibility getter; active shader is embedded once.\n"
                         f"fun {old_getter}() -> EmbeddedShader:\n"
                         f"    return {active_getter}()\n")
                src = src[:start] + alias + src[stop:]

    if begin in src and end in src:
        pre = src[: src.index(begin)]
        post = src[src.index(end) + len(end):]
        if f"fun {getter}()" in pre + post:
            raise SystemExit(f"duplicate getter {getter} outside {name}; resolve the existing shader name first")
        new = pre + block + post
    else:
        if f"fun {getter}()" in src:
            raise SystemExit(f"getter {getter} already exists under another shader name; refusing to append a duplicate")
        new = src.rstrip("\n") + "\n\n" + block + "\n"

    # Keep LF: text mode on Windows would turn every line into CRLF.
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    print(f"[regen] {getter} <- {os.path.basename(spv_path)} "
          f"({os.path.getsize(spv_path)} bytes) into {target}")


if __name__ == "__main__":
    main()
