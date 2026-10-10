"""Embedding must replace the active shader and never duplicate its getter."""
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

REGEN = Path(__file__).resolve().parents[1] / 'tools' / 'regen_shader.py'


class ShaderEmbeddingChecks(unittest.TestCase):
    def test_replace_and_reject_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spv, target = root / 'fixture.spv', root / 'shaders.dlt'
            spv.write_bytes(struct.pack('<2I', 0x07230203, 17))
            target.write_text('# existing shaders\n', encoding='utf-8')

            def run(name):
                return subprocess.run(
                    [sys.executable, str(REGEN), str(spv), name,
                     'get_textured_frag_shader', '--file', str(target)],
                    capture_output=True, text=True)

            self.assertEqual(run('tex_frag').returncode, 0)
            original = target.read_bytes()
            self.assertEqual(run('tex_frag').returncode, 0)
            self.assertEqual(target.read_bytes(), original)
            self.assertNotEqual(run('textured_frag').returncode, 0)
            self.assertEqual(target.read_bytes(), original)
            # Also reject a pre-existing duplicate outside the replaced block.
            target.write_text(target.read_text(encoding='utf-8') +
                              '\nfun get_textured_frag_shader() -> EmbeddedShader:\n'
                              '    return EmbeddedShader()\n', encoding='utf-8')
            duplicate = target.read_bytes()
            self.assertNotEqual(run('tex_frag').returncode, 0)
            self.assertEqual(target.read_bytes(), duplicate)


if __name__ == '__main__':
    unittest.main()
