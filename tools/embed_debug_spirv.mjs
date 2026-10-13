import fs from "node:fs";
import path from "node:path";

const CHUNK_WORDS = 120;
const START_MARKER = "# BEGIN GENERATED DEBUG COLLISION SHADERS";
const END_MARKER = "# END GENERATED DEBUG COLLISION SHADERS";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readWords(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length === 0 || data.length % 4 !== 0) {
    fail(`Invalid SPIR-V file: ${filePath}`);
  }

  const words = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    words.push(data.readInt32LE(offset));
  }
  return { words, byteLength: data.length };
}

function emitShader(prefix, getterName, compiled) {
  const chunks = [];
  for (let start = 0; start < compiled.words.length; start += CHUNK_WORDS) {
    const index = chunks.length;
    const lines = [`fun _kobic_init_${prefix}_shader_p${index}(buf: i64) -> void:`];
    const end = Math.min(start + CHUNK_WORDS, compiled.words.length);
    for (let wordIndex = start; wordIndex < end; wordIndex += 1) {
      lines.push(`    Memory.write_i32(buf + ${wordIndex * 4}, ${compiled.words[wordIndex]})`);
    }
    chunks.push(lines.join("\n"));
  }

  const init = [`fun _kobic_init_${prefix}_shader(buf: i64) -> void:`];
  for (let index = 0; index < chunks.length; index += 1) {
    init.push(`    _kobic_init_${prefix}_shader_p${index}(buf)`);
  }

  const getter = [
    `fun ${getterName}() -> EmbeddedShader:`,
    "    shader: EmbeddedShader = EmbeddedShader()",
    `    buf: i64 = Memory.malloc_zeroed(${compiled.byteLength})`,
    "    if buf == 0:",
    "        return shader",
    `    _kobic_init_${prefix}_shader(buf)`,
    "    shader.data = buf",
    `    shader.size = ${compiled.byteLength}`,
    "    return shader",
  ];

  return [...chunks, init.join("\n"), getter.join("\n")].join("\n\n");
}

const [vertexPath, fragmentPath, outputPathArg] = process.argv.slice(2);
if (!vertexPath || !fragmentPath) {
  fail("Usage: node tools/embed_debug_spirv.mjs <vertex.spv> <fragment.spv> [gpu_shaders.dlt]");
}

const outputPath = outputPathArg ?? path.join("render", "gpu_shaders.dlt");
let current = fs.readFileSync(outputPath, "utf8");
const start = current.indexOf(START_MARKER);
if (start >= 0) {
  const end = current.indexOf(END_MARKER, start);
  if (end < 0) {
    fail(`Missing ${END_MARKER} in ${outputPath}`);
  }
  current = current.slice(0, start) + current.slice(end + END_MARKER.length).replace(/^\s+/, "");
}

const vertex = readWords(vertexPath);
const fragment = readWords(fragmentPath);
const generated = [
  START_MARKER,
  "# Generated from render/shaders/debug_collision.vert and debug_collision.frag.",
  "",
  emitShader("debug_collision_vert", "get_debug_collision_vert_shader", vertex),
  "",
  emitShader("debug_collision_frag", "get_debug_collision_frag_shader", fragment),
  "",
  END_MARKER,
  "",
].join("\n");

fs.writeFileSync(outputPath, `${current.trimEnd()}\n\n${generated}`, "utf8");
console.log(`Embedded ${vertex.byteLength}-byte debug vertex and ${fragment.byteLength}-byte debug fragment shaders.`);
