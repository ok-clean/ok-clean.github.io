import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/stage-pages.sh"

class PagesStagingTest(unittest.TestCase):
    def test_existing_pages_kept_prototype_excluded(self):
        with tempfile.TemporaryDirectory() as temp:
            src, dest = Path(temp) / "source", Path(temp) / "output"
            fixtures = {
                "index.html": "home",
                "services/aircon.html": "service",
                "area/춘천.html": "region",
                "admin/index.html": "existing admin",
                "site.js": "script",
                ".well-known/example": "existing hidden asset",
                "prototype/quote-request.html": "demo only",
                "prototype/security/firestore.rules": "demo rules",
                ".git/config": "git metadata",
            }
            for name, content in fixtures.items():
                path = src / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            subprocess.run(["bash", str(SCRIPT), str(src), str(dest)], check=True)
            for name, content in fixtures.items():
                target = dest / name
                if name.startswith(("prototype/", ".git/")):
                    self.assertFalse(target.exists(), name)
                else:
                    self.assertEqual(target.read_text(encoding="utf-8"), content)

    def test_actual_tracked_site_files_preserved(self):
        root = SCRIPT.parents[1]
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "output"
            subprocess.run(["bash", str(SCRIPT), str(root), str(dest)], check=True)
            names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode("utf-8").split("\\0")
            for name in names:
                if not name or name.startswith("prototype/"):
                    continue
                source, target = root / name, dest / name
                if source.is_symlink():
                    self.assertTrue(target.is_symlink(), name)
                    self.assertEqual(target.readlink(), source.readlink(), name)
                elif source.is_file():
                    self.assertEqual(target.read_bytes(), source.read_bytes(), name)

if __name__ == "__main__":
    unittest.main()
