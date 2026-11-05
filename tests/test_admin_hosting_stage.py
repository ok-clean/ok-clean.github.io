import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('admin_hosting_stage', ROOT / 'scripts/stage_admin_hosting.py')
stage_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage_module)


class AdminHostingStageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.source = self.parent / 'source'
        (self.source / 'admin').mkdir(parents=True)
        for name in stage_module.COPY_FILES:
            (self.source / name).write_text('reviewed source asset', encoding='utf-8')
        self.html = ('<!doctype html><html><head><link rel="manifest" href="manifest.webmanifest">'
                     '<link rel="icon" href="icon-192.png">'
                     '<link rel="apple-touch-icon" href="apple-touch-icon.png">'
                     '<link rel="stylesheet" href="../install.css">'
                     '<script src="../install.js" defer data-app="admin"></script>'
                     '</head><body><button id="loginBtn">Google 로그인</button>'
                     '<script type="module" src="admin.js"></script></body></html>')
        (self.source / 'admin/index.html').write_text(self.html, encoding='utf-8')
        self.manifest = {'name': '오케이청소 관리자', 'id': '/admin/', 'start_url': '/admin/',
                         'scope': '/admin/', 'display': 'standalone', 'icons': [
                             {'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
                             {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'}]}
        self.write_manifest()
        self.firebase = {'apiKey': 'synthetic-public-api-key', 'projectId': 'okclean-admin',
                         'appId': 'synthetic-app-id', 'authDomain': 'okclean-admin.firebaseapp.com',
                         'unexpected': 'must not be copied'}
        (self.source / 'config.json').write_text(json.dumps({
            'firebase': self.firebase, 'customerContent': 'must not be published'}), encoding='utf-8')
        (self.source / 'firebase.admin-hosting.json').write_bytes((ROOT / 'firebase.admin-hosting.json').read_bytes())
        self.output = self.parent / 'bundle'

    def write_manifest(self):
        (self.source / 'admin/manifest.webmanifest').write_text(json.dumps(self.manifest), encoding='utf-8')

    def build(self, **kwargs):
        options = {'site_id': 'okclean-admin-app', 'origin': 'https://okclean-admin-app.web.app'}
        options.update(kwargs)
        return stage_module.stage(self.source, self.output, **options)

    def test_only_admin_assets_and_minimal_same_project_config_are_published(self):
        (self.source / 'member-export.json').write_text('private data must not be copied')
        (self.source / 'index.html').write_text('customer homepage must not be copied')
        original_admin = (self.source / 'admin/admin.js').read_bytes()
        report = self.build()
        actual = {p.relative_to(self.output / 'public').as_posix()
                  for p in (self.output / 'public').rglob('*') if p.is_file()}
        self.assertEqual(actual, set(stage_module.COPY_FILES) | {'config.json', 'sw.js', 'robots.txt'})
        self.assertEqual(set(report['files']), actual)
        self.assertEqual(report['status'], 'prepared_only_not_deployed')
        self.assertEqual((self.output / 'public/admin/admin.js').read_bytes(), original_admin)
        self.assertEqual((self.source / 'admin/index.html').read_text(encoding='utf-8'), self.html)
        config = json.loads((self.output / 'public/config.json').read_text())
        expected = {k: self.firebase[k] for k in ('apiKey', 'projectId', 'appId')}
        expected['authDomain'] = 'okclean-admin-app.web.app'
        self.assertEqual(config, {'firebase': expected})
        self.assertEqual(json.loads((self.source / 'config.json').read_text())['firebase']['authDomain'],
                         'okclean-admin.firebaseapp.com')
        hosting = json.loads((self.output / 'firebase.json').read_text())
        self.assertEqual(set(hosting), {'hosting'})
        self.assertEqual(hosting['hosting']['site'], 'okclean-admin-app')
        self.assertEqual(hosting['hosting']['public'], 'public')
        self.assertNotIn('target', hosting['hosting'])
        self.assertEqual(hosting['hosting']['redirects'], [{'source': '/', 'destination': '/admin/', 'type': 302}])
        self.assertNotIn('rewrites', hosting['hosting'])

    def test_selected_firebase_alias_has_same_origin_auth_helper(self):
        self.build(origin='https://okclean-admin-app.firebaseapp.com')
        config = json.loads((self.output / 'public/config.json').read_text())['firebase']
        self.assertEqual(config['projectId'], 'okclean-admin')
        self.assertEqual(config['authDomain'], 'okclean-admin-app.firebaseapp.com')
        html = (self.output / 'public/admin/index.html').read_text(encoding='utf-8')
        self.assertIn('https://okclean-admin-app.firebaseapp.com/admin/', html)
        self.assertIn('location.origin==="https://okclean-admin-app.web.app"', html)
        self.assertNotIn('ok-clean.github.io', html)

    def test_destination_cannot_replace_existing_files_or_write_into_source(self):
        self.output.mkdir()
        sentinel = self.output / 'existing'
        sentinel.write_text('retain me')
        with self.assertRaisesRegex(ValueError, 'must not exist'):
            self.build()
        self.assertEqual(sentinel.read_text(), 'retain me')
        with self.assertRaisesRegex(ValueError, 'outside source'):
            stage_module.stage(self.source, self.source / 'generated', site_id='okclean-admin-app',
                               origin='https://okclean-admin-app.web.app')

    def test_rejects_unreviewed_hostnames_and_other_projects(self):
        for origin in ('https://ok-clean.github.io', 'https://okclean-admin-app.web.app.evil.test',
                       'http://okclean-admin-app.web.app', 'https://okclean-admin-app.web.app/admin/'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.build(origin=origin)
        with self.assertRaisesRegex(ValueError, 'never select the default site'):
            self.build(site_id='okclean-admin', origin='https://okclean-admin.firebaseapp.com')
        config = json.loads((self.source / 'config.json').read_text())
        config['firebase']['projectId'] = 'other-project'
        (self.source / 'config.json').write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'project must remain'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_symlink_assets_and_missing_referenced_files(self):
        asset = self.source / 'admin/icon-192.png'
        asset.unlink()
        asset.symlink_to(self.source / 'config.json')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            self.build()
        asset.unlink()
        asset.write_text('reviewed source asset')
        self.manifest['icons'][0]['src'] = '../customer-only.png'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'Missing admin-only asset'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_manifest_identity_or_origin_drift(self):
        self.manifest['scope'] = '/'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'must remain /admin/'):
            self.build()
        self.manifest['scope'] = '/admin/'
        self.manifest['icons'][0]['src'] = 'https://ok-clean.github.io/icon-192.png'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'must be local'):
            self.build()

    def test_worker_never_intercepts_auth_or_database_and_never_returns_customer_fallback(self):
        self.build()
        script = r'''
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const handlers = {}, origin = 'https://okclean-admin-app.web.app';
let fetchCalls = 0, offline = false;
const context = { URL, self: { location: { origin }, addEventListener: (n, f) => handlers[n] = f,
  skipWaiting: async () => {}, clients: { claim: async () => {} } },
  fetch: async request => { fetchCalls++; if (offline) throw new Error('offline'); return {url: request.url}; },
  caches: new Proxy({}, {get: () => {throw new Error('No data or shell may be cached by this worker');}})
};
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), context);
function request(url, method = 'GET') {
 let response;
 handlers.fetch({request: {url, method}, respondWith: r => response = r});
 return response;
}
(async () => {
 assert.equal(request(origin + '/__/auth/handler'), undefined);
 assert.equal(request(origin + '/__/auth/iframe'), undefined);
 assert.equal(request('https://firestore.googleapis.com/data'), undefined);
 assert.equal(request('https://identitytoolkit.googleapis.com/auth'), undefined);
 assert.equal(request(origin + '/admin/', 'POST'), undefined);
 assert.equal(fetchCalls, 0);
 assert.equal((await request(origin + '/admin/')).url, origin + '/admin/');
 offline = true;
 await assert.rejects(request(origin + '/admin/'), /offline/);
 assert.equal(fetchCalls, 2);
})().catch(error => {console.error(error); process.exitCode = 1;});
'''
        result = subprocess.run(['node', '-e', script, str(self.output / 'public/sw.js')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
