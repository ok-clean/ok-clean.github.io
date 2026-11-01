"""Exercise the actual workflow's staging and git commands on local-only repositories."""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/update.yml").read_text(encoding="utf-8")
STAGE = 'python scripts/stage_pages.py . "$RUNNER_TEMP/okclean-pages"'
REQUIRED = ('index.html', 'app.js', 'site.js', 'style.css', 'sw.js',
            'privacy.html', 'sitemap.xml', 'robots.txt', 'manifest.webmanifest')


def workflow_commands():
    stage = re.search(r'(?m)^      - name: Pages 배포 파일 준비\n        run: (.+)$', WORKFLOW)
    save = re.search(r'(?m)^      - name: 바뀐 파일 저장\n        run: \|\n((?:          .*\n)+)', WORKFLOW)
    upload = WORKFLOW.find('uses: actions/upload-pages-artifact@v3')
    deploy = WORKFLOW.find('uses: actions/deploy-pages@v4')
    if not stage or not save or stage.group(1) != STAGE or not (stage.start() < save.start() < upload < deploy):
        raise AssertionError('Staging must precede repository write, upload and deploy')
    return stage.group(1), '\n'.join(line[10:] for line in save.group(1).splitlines())


class PublishGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.remote = self.root / "remote.git"
        self.work = self.root / "work"
        self.editor = self.root / "editor"
        self.runner = self.root / "runner"
        self.runner.mkdir()
        self.env = {**os.environ, 'GIT_CONFIG_NOSYSTEM':'1', 'GIT_CONFIG_GLOBAL':os.devnull,
                    'GIT_TERMINAL_PROMPT':'0', 'RUNNER_TEMP':str(self.runner)}
        self.run_cmd(['git','init','--bare','--initial-branch=main',str(self.remote)], self.root)
        self.run_cmd(['git','init','--initial-branch=main',str(self.work)], self.root)
        self.run_cmd(['git','config','user.name','Test User'], self.work)
        self.run_cmd(['git','config','user.email','test@example.invalid'], self.work)
        self.run_cmd(['git','remote','add','origin',str(self.remote)], self.work)
        for name in REQUIRED:
            (self.work / name).write_text('baseline', encoding='utf-8')
        (self.work / 'scripts').mkdir()
        shutil.copyfile(ROOT / 'scripts/stage_pages.py', self.work / 'scripts/stage_pages.py')
        self.run_cmd(['git','add','.'], self.work)
        self.run_cmd(['git','commit','-m','baseline'], self.work)
        self.run_cmd(['git','push','-u','origin','main'], self.work)
        self.run_cmd(['git','clone',str(self.remote),str(self.editor)], self.root)
        self.run_cmd(['git','config','user.name','Test Editor'], self.editor)
        self.run_cmd(['git','config','user.email','editor@example.invalid'], self.editor)
        self.stage, self.save = workflow_commands()

    def run_cmd(self, command, cwd, check=True):
        return subprocess.run(command, cwd=cwd, env=self.env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

    def remote_value(self):
        return self.run_cmd(['git','show','main:index.html'], self.remote).stdout

    def remote_head(self):
        return self.run_cmd(['git','rev-parse','main'], self.remote).stdout.strip()

    def run_workflow_steps(self):
        # GitHub Actions uses separate shell invocations with fail-fast behavior.
        result = self.run_cmd(['bash','-eo','pipefail','-c',self.stage], self.work, check=False)
        if result.returncode:
            return result, False
        result = self.run_cmd(['bash','-eo','pipefail','-c',self.save], self.work, check=False)
        return result, result.returncode == 0

    def test_valid_build_stages_then_pushes_same_content(self):
        (self.work / 'index.html').write_text('generated', encoding='utf-8')
        result, upload_would_run = self.run_workflow_steps()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(upload_would_run)
        self.assertEqual(self.remote_value(), 'generated')
        self.assertEqual((self.runner / 'okclean-pages/index.html').read_text(), 'generated')

    def test_unchanged_build_succeeds_without_a_new_commit(self):
        before = self.remote_head()
        result, upload_would_run = self.run_workflow_steps()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(upload_would_run)
        self.assertEqual(self.remote_head(), before)

    def test_staging_failure_prevents_commit_push_and_upload(self):
        before = self.remote_head()
        (self.work / 'index.html').write_text('unvalidated', encoding='utf-8')
        (self.work / 'sw.js').unlink()
        result, upload_would_run = self.run_workflow_steps()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(upload_would_run)
        self.assertEqual(self.remote_head(), before)
        self.assertEqual(self.remote_value(), 'baseline')
        self.assertEqual(self.run_cmd(['git','rev-parse','HEAD'], self.work).stdout.strip(), before)

    def test_concurrent_remote_commit_is_never_rebased_over_or_uploaded(self):
        (self.work / 'index.html').write_text('generated-from-old-base', encoding='utf-8')
        (self.editor / 'index.html').write_text('new-editor-content', encoding='utf-8')
        self.run_cmd(['git','add','index.html'], self.editor)
        self.run_cmd(['git','commit','-m','editor update'], self.editor)
        self.run_cmd(['git','push'], self.editor)
        editor_head = self.remote_head()
        result, upload_would_run = self.run_workflow_steps()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(upload_would_run)
        self.assertEqual(self.remote_head(), editor_head)
        self.assertEqual(self.remote_value(), 'new-editor-content')

    def test_remote_change_with_no_local_change_stops_upload(self):
        (self.editor / 'index.html').write_text('new-editor-content', encoding='utf-8')
        self.run_cmd(['git','add','index.html'], self.editor)
        self.run_cmd(['git','commit','-m','editor update'], self.editor)
        self.run_cmd(['git','push'], self.editor)
        editor_head = self.remote_head()
        result, upload_would_run = self.run_workflow_steps()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(upload_would_run)
        self.assertEqual(self.remote_head(), editor_head)
        self.assertEqual(self.remote_value(), 'new-editor-content')


if __name__ == '__main__':
    unittest.main()
