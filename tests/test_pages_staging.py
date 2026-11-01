import os
import hashlib
import importlib.util
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'stage_pages.py'
REQUIRED = ('index.html', 'app.js', 'site.js', 'style.css', 'sw.js',
            'privacy.html', 'sitemap.xml', 'robots.txt', 'manifest.webmanifest')


class PagesStagingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.src = self.root / 'source'
        self.out = self.root / 'published'
        self.files = {name: f'가상 {name}' for name in REQUIRED}
        self.files['index.html'] = '<a href="services/aircon.html">서비스</a><img src="/.well-known/icon.png">'
        self.files.update({
            'services/aircon.html': '<script src="../site.js"></script>',
            'area/춘천.html': '<a href="../index.html">홈</a>',
            'admin/index.html': '가상 관리자',
            'admin-setup/index.html': '가상 설정 안내',
            '.well-known/icon.png': '가상 아이콘',
            '.nojekyll': '',
            'google-verification.html': '가상 검색 인증',
            'config.json': '{"name":"가상"}',
            'cases.json': '{"cases":[]}',
            'scripts/other.js': '가상 사용자 파일',
            '.github/workflows/example.yml': '가상 작업',
            '.git/config': '가상 git',
            'docs/internal.md': '가상 개발 문서',
            'tests/test.js': '가상 테스트',
            'prototype/index.html': '가상 시제품',
            '__pycache__/build.pyc': '가상 캐시',
            'scripts/__pycache__/stage.pyc': '가상 중첩 캐시',
            'scripts/stage_pages.py': '가상 스테이징 도구',
        })
        for name, content in self.files.items():
            path = self.src / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')

    def run_stage(self, source=None, destination=None):
        return subprocess.run([sys.executable, str(SCRIPT), str(source or self.src), str(destination or self.out)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_only_development_paths_are_excluded_and_every_other_byte_is_preserved(self):
        result = self.run_stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, content in self.files.items():
            target = self.out / name
            excluded = name.startswith(('.git/', 'docs/', 'tests/', 'prototype/', '__pycache__/')) or '/__pycache__/' in name or name == 'scripts/stage_pages.py'
            if excluded:
                self.assertFalse(os.path.lexists(target), name)
            else:
                self.assertEqual(target.read_bytes(), (self.src / name).read_bytes(), name)
        self.assertEqual((self.src / 'prototype/index.html').read_text(encoding='utf-8'), '가상 시제품')

    def test_existing_or_nested_destination_is_rejected_without_mutation(self):
        self.out.mkdir()
        (self.out / 'sentinel').write_text('가상 기존 파일', encoding='utf-8')
        self.assertNotEqual(self.run_stage().returncode, 0)
        self.assertEqual((self.out / 'sentinel').read_text(encoding='utf-8'), '가상 기존 파일')
        nested = self.src / 'nested-output'
        self.assertNotEqual(self.run_stage(destination=nested).returncode, 0)
        self.assertFalse(nested.exists())

    def test_missing_required_site_file_fails_without_output(self):
        (self.src / 'index.html').unlink()
        self.assertNotEqual(self.run_stage().returncode, 0)
        self.assertFalse(self.out.exists())

    def test_empty_homepage_fails_without_output(self):
        (self.src / 'index.html').write_text('', encoding='utf-8')
        self.assertNotEqual(self.run_stage().returncode, 0)
        self.assertFalse(self.out.exists())

    def test_symlinks_to_external_excluded_and_missing_paths_fail_closed(self):
        for target in (self.root / 'outside', self.src / 'tests', self.root / 'missing'):
            with self.subTest(target=target):
                link = self.src / 'bad-link'
                link.symlink_to(target, target_is_directory=target == self.src / 'tests')
                self.assertNotEqual(self.run_stage().returncode, 0)
                self.assertFalse(self.out.exists())
                link.unlink()

    def test_html_links_to_excluded_paths_cannot_silently_break(self):
        targets = [('index.html', '/tests/test.js'), ('index.html', '../docs/internal.md'),
                   ('index.html', '/te%73ts%2Ftest.js'), ('index.html', '/scripts/stage_pages.py'),
                   ('index.html', 'https://ok-clean.github.io/prototype/index.html'),
                   ('services/aircon.html', '../../docs/internal.md')]
        for page, target in targets:
            with self.subTest(page=page, target=target):
                (self.src / page).write_text(f'<a href="{target}">링크</a>', encoding='utf-8')
                self.assertNotEqual(self.run_stage().returncode, 0)
                self.assertFalse(self.out.exists())
                (self.src / page).write_text(self.files[page], encoding='utf-8')

    def test_symlinked_destination_cannot_be_used_as_stale_output(self):
        self.out.symlink_to(self.root / 'missing', target_is_directory=True)
        self.assertNotEqual(self.run_stage().returncode, 0)
        self.assertTrue(self.out.is_symlink())

    @unittest.skipUnless(shutil.which('tar'), 'tar is needed to simulate the Pages artifact')
    def test_simulated_pages_archive_excludes_development_but_keeps_hidden_site_files(self):
        result = self.run_stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.root / 'pages.tar.gz'
        subprocess.run(['tar', '--dereference', '--hard-dereference', '--exclude=.git', '--exclude=.github',
                        '-C', str(self.out), '-czf', str(archive), '.'], check=True)
        with tarfile.open(archive, 'r:gz') as bundle:
            names = {n.removeprefix('./') for n in bundle.getnames()}
        for name in ('index.html', 'services/aircon.html', 'area/춘천.html', 'admin/index.html',
                     '.well-known/icon.png', '.nojekyll', 'google-verification.html'):
            self.assertIn(name, names)
        for name in ('docs/internal.md', 'tests/test.js', 'prototype/index.html', '.git/config',
                     '.github/workflows/example.yml', 'scripts/stage_pages.py'):
            self.assertNotIn(name, names)

    def test_checkout_is_byte_identical_except_explicit_exclusions(self):
        root = SCRIPT.parents[1]
        if not (root / '.git').exists():
            self.skipTest('This check needs the CI checkout')
        result = self.run_stage(source=root)
        self.assertEqual(result.returncode, 0, 'Staging the checkout failed; inspect the staging error without printing file content')
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location('stage_pages', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = set()
        actual = set()
        for base, dirs, files in os.walk(root, followlinks=False):
            directory = Path(base)
            dirs[:] = [d for d in dirs if not module.excluded((directory / d).relative_to(root).as_posix())]
            for name in files:
                source = directory / name
                rel = source.relative_to(root).as_posix()
                if module.excluded(rel):
                    continue
                expected.add(rel)
                target = self.out / rel
                self.assertTrue(target.is_file(), f'Missing published file: {rel}')
                # Never print file content, including the operational config.
                self.assertTrue(hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest(),
                                f'Published file changed: {rel}')
                if rel.lower().endswith(('.html', '.htm')):
                    # All absolute and external URI attributes are unchanged as well.
                    # Verify every existing relative or same-site target remains present.
                    parser = module.Links()
                    parser.feed(source.read_text(encoding='utf-8'))
                    for raw in parser.urls:
                        url = module.urlsplit(raw.strip())
                        if url.scheme and url.scheme not in ('http', 'https'):
                            continue
                        if url.netloc and url.hostname != 'ok-clean.github.io':
                            continue
                        if not url.path:
                            continue
                        value = module.unquote(url.path)
                        resolved = module.posixpath.normpath(module.posixpath.join('/', module.posixpath.dirname(rel), value)).lstrip('/')
                        before = root / resolved
                        after = self.out / resolved
                        if before.exists():
                            self.assertTrue(after.exists(), f'Existing linked asset missing: {rel}')
        for base, dirs, files in os.walk(self.out, followlinks=False):
            for name in files:
                actual.add((Path(base) / name).relative_to(self.out).as_posix())
        self.assertEqual(expected, actual)


if __name__ == '__main__':
    unittest.main()
