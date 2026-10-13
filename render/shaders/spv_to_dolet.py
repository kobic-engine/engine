#!/usr/bin/env python3
"""Convert a .spv (SPIR-V) file into a Dolet init function that fills a
buffer with Memory.write_i32 calls, matching the embedding style used by
gpu_shaders.dlt. Prints the Dolet source to stdout.

Usage: python spv_to_dolet.py cull.comp.spv _kobic_init_cull_shader
"""
import sys, struct

def main():
    spv_path = sys.argv[1]
    fn_name = sys.argv[2]
    with open(spv_path, "rb") as f:
        data = f.read()
    if len(data) % 4 != 0:
        print(f"// WARNING: {spv_path} length {len(data)} not multiple of 4", file=sys.stderr)
    words = struct.unpack("<%dI" % (len(data) // 4), data)
    # i32 expects signed; convert >2^31 to negative two's complement.
    lines = []
    lines.append(f"# Compute shader: {len(data)} bytes ({len(words)} i32 words) — GPU-driven culling")
    lines.append(f"fun {fn_name}(buf: i64) -> void:")
    off = 0
    for w in words:
        sw = w if w < 0x80000000 else w - 0x100000000
        lines.append(f"    Memory.write_i32(buf + {off}, {sw})")
        off += 4
    print("\n".join(lines))
    print(f"\n# size_bytes = {len(data)}", file=sys.stderr)

if __name__ == "__main__":
    main()
