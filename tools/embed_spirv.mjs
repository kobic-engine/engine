import fs from "node:fs";
import path from "node:path";

const CHUNK_WORDS = 120;
const GENERATED_MARKER = "# BEGIN GENERATED TEXTURED SHADERS";
const GENERATED_END_MARKER = "# END GENERATED TEXTURED SHADERS";

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

const [vertexPath, fragmentPath, shadowVertexPath, skyVertexPath, skyFragmentPath, bloomFragmentPath, outputPathArg] = process.argv.slice(2);
if (!vertexPath || !fragmentPath || !shadowVertexPath || !skyVertexPath || !skyFragmentPath) {
  fail("Usage: node tools/embed_spirv.mjs <vertex.spv> <fragment.spv> <shadow-vertex.spv> <sky-vertex.spv> <sky-fragment.spv> [bloom-fragment.spv] [gpu_shaders.dlt]");
}

let finalBloomFragmentPath = bloomFragmentPath;
let finalOutputPathArg = outputPathArg;
if (bloomFragmentPath && !outputPathArg && bloomFragmentPath.endsWith(".dlt")) {
  finalBloomFragmentPath = "";
  finalOutputPathArg = bloomFragmentPath;
}
const outputPath = finalOutputPathArg ?? path.join("render", "gpu_shaders.dlt");
const current = fs.readFileSync(outputPath, "utf8");
let markerIndex = current.indexOf(GENERATED_MARKER);
if (markerIndex < 0) {
  markerIndex = current.indexOf("# Textured vertex shader");
}
if (markerIndex < 0) {
  fail(`Could not find generated shader section in ${outputPath}`);
}
const endMarkerIndex = current.indexOf(GENERATED_END_MARKER, markerIndex);
const preservedTail =
  endMarkerIndex >= 0
    ? current
        .slice(endMarkerIndex + GENERATED_END_MARKER.length)
        .replace(/^\s+/, "")
    : "";

const vertex = readWords(vertexPath);
const fragment = readWords(fragmentPath);
const shadowVertex = readWords(shadowVertexPath);
const skyVertex = readWords(skyVertexPath);
const skyFragment = readWords(skyFragmentPath);
const bloomFragment = finalBloomFragmentPath ? readWords(finalBloomFragmentPath) : null;
const generated = [
  GENERATED_MARKER,
  "# Generated from the GLSL files in render/shaders.",
  "# Run glslangValidator, then tools/embed_spirv.mjs to regenerate.",
  "",
  emitShader("tex_vert", "get_textured_vert_shader", vertex),
  "",
  emitShader("tex_frag", "get_textured_frag_shader", fragment),
  "",
  emitShader("shadow_vert", "get_shadow_vert_shader", shadowVertex),
  "",
  emitShader("sky_vert", "get_sky_vert_shader", skyVertex),
  "",
  emitShader("sky_frag", "get_sky_frag_shader", skyFragment),
  ...(bloomFragment
    ? [
        "",
        emitShader("bloom_frag", "get_bloom_frag_shader", bloomFragment),
      ]
    : []),
  "",
  "# END GENERATED TEXTURED SHADERS",
  "",
].join("\n");

const tail = preservedTail.length > 0 ? `\n${preservedTail}` : "";
fs.writeFileSync(outputPath, current.slice(0, markerIndex) + generated + tail, "utf8");
const bloomMessage = bloomFragment ? `, and ${bloomFragment.byteLength}-byte bloom fragment` : "";
console.log(`Embedded ${vertex.byteLength}-byte vertex, ${fragment.byteLength}-byte fragment, ${shadowVertex.byteLength}-byte shadow vertex, ${skyVertex.byteLength}-byte sky vertex, ${skyFragment.byteLength}-byte sky fragment${bloomMessage} shaders.`);
