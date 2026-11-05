#!/usr/bin/env python3
"""Build a reviewable admin-only Hosting bundle; never contact or deploy to Firebase.

The destination must be new and outside the source tree. A Firebase site ID and
canonical origin are required explicitly. This is preparation, not evidence that
the site exists, its previous content can be replaced, or its OAuth settings work.
"""

import argparse
import hashlib
import json
import os
import shutil
import stat
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit


PROJECT_ID = 'okclean-admin'
SITE_ID = 'okclean-admin-app'
COPY_FILES = (
    'admin/index.html', 'admin/admin.js', 'admin/manifest.webmanifest',
    'admin/icon-192.png', 'admin/icon-512.png', 'admin/apple-touch-icon.png',
    'install.js', 'install.css',
)
CONFIG_KEYS = ('apiKey', 'projectId', 'appId')
WORKER = """'use strict';
// Admin-only origin: no offline customer page, CacheStorage, SDK or auth-helper interception.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/__/')) return;
  event.respondWith(fetch(event.request));
});
"""


def read_source(source, relative):
    path = source / relative
    for component in (path, *path.parents):
        if component == source:
            break
        if component.is_symlink():
            raise ValueError(f'Symlink is not an approved public asset: {relative}')
    mode = path.stat().st_mode
    if not stat.S_ISREG(mode) or path.stat().st_size == 0:
        raise ValueError(f'Missing or invalid public asset: {relative}')
    return path.read_bytes()


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('href', 'src') and value:
                self.urls.append(value)


def validate_links(public, origin):
    parser = Links()
    parser.feed((public / 'admin/index.html').read_text(encoding='utf-8'))
    manifest = json.loads((public / 'admin/manifest.webmanifest').read_text(encoding='utf-8'))
    if (manifest.get('id'), manifest.get('start_url'), manifest.get('scope')) != ('/admin/',) * 3:
        raise ValueError('Administrator manifest identity, start and scope must remain /admin/')
    icons = manifest.get('icons', [])
    if not {'192x192', '512x512'}.issubset({icon.get('sizes') for icon in icons}):
        raise ValueError('Administrator manifest needs its reviewed 192 and 512 icons')
    for icon in icons:
        if urlsplit(icon.get('src', '')).scheme or urlsplit(icon.get('src', '')).netloc:
            raise ValueError('Administrator icons must be local reviewed assets')
        parser.urls.append(icon['src'])
    for raw in parser.urls:
        if raw.startswith('#'):
            continue
        url = urlsplit(urljoin(origin + '/admin/', raw))
        if url.scheme != 'https' or url.netloc != urlsplit(origin).netloc:
            raise ValueError(f'Administrator HTML or manifest refers outside its origin: {raw}')
        path = public / unquote(url.path).lstrip('/')
        if url.path.endswith('/'):
            path /= 'index.html'
        if not path.is_file():
            raise ValueError(f'Missing admin-only asset referenced by HTML or manifest: {raw}')


def stage(source_arg, destination_arg, *, site_id, origin):
    source = Path(source_arg).resolve(strict=True)
    destination = Path(destination_arg).absolute()
    if not source.is_dir():
        raise ValueError('Source must be a directory')
    if site_id != SITE_ID:
        raise ValueError('Only the new dedicated okclean-admin-app site is prepared; never select the default site')
    canonical = origin.rstrip('/')
    allowed_origins = {f'https://{site_id}.firebaseapp.com', f'https://{site_id}.web.app'}
    if canonical not in allowed_origins:
        raise ValueError('Canonical origin must be the exact Firebase hostname for the selected site')
    if os.path.lexists(destination):
        raise ValueError('Destination must not exist; previous build will not be overwritten')
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if parent == source or source in parent.parents:
        raise ValueError('Destination must be outside source')

    assets = {name: read_source(source, name) for name in COPY_FILES}
    original = json.loads(read_source(source, 'config.json')).get('firebase', {})
    if original.get('projectId') != PROJECT_ID:
        raise ValueError('The existing Firebase project must remain okclean-admin')
    if any(not isinstance(original.get(key), str) or not original[key] for key in CONFIG_KEYS):
        raise ValueError('Required existing Firebase public identifiers are missing')
    # Same-project identifiers are unchanged. Match the helper to the new origin;
    # the domain and OAuth handler must be authorized before any live deployment.
    firebase = {key: original[key] for key in CONFIG_KEYS}
    firebase['authDomain'] = urlsplit(canonical).hostname
    config = json.loads(read_source(source, 'firebase.admin-hosting.json'))
    if set(config) != {'hosting'} or config['hosting'].get('site') != SITE_ID:
        raise ValueError('Only the reviewed admin Hosting target may be staged')

    temporary = Path(tempfile.mkdtemp(prefix='.okclean-admin-stage-', dir=parent))
    try:
        public = temporary / 'public'
        for name, content in assets.items():
            target = public / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        html = assets['admin/index.html'].decode('utf-8')
        alias = (allowed_origins - {canonical}).pop()
        # One canonical install origin prevents duplicate installations via the
        # two Firebase aliases. Local previews and GitHub Pages are not redirected.
        prefix = (f'<link rel="canonical" href="{canonical}/admin/">'
                  '<meta name="robots" content="noindex,nofollow">'
                  '<script>if(location.origin===' + json.dumps(alias) + '){'
                  'location.replace(' + json.dumps(canonical) +
                  '+location.pathname+location.search+location.hash);}</script>')
        if html.count('<head>') != 1:
            raise ValueError('Expected one admin document head')
        (public / 'admin/index.html').write_text(html.replace('<head>', '<head>' + prefix, 1), encoding='utf-8')
        (public / 'config.json').write_text(json.dumps({'firebase': firebase}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (public / 'sw.js').write_text(WORKER, encoding='utf-8')
        (public / 'robots.txt').write_text('User-agent: *\nDisallow: /\n', encoding='utf-8')
        validate_links(public, canonical)
        (temporary / 'firebase.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        report = {'project_id': PROJECT_ID, 'site_id': site_id, 'canonical_origin': canonical,
                  'requires_new_site': True,
                  'status': 'prepared_only_not_deployed', 'files': {}}
        for path in sorted(public.rglob('*')):
            if path.is_file():
                data = path.read_bytes()
                report['files'][path.relative_to(public).as_posix()] = {
                    'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        report['total_bytes'] = sum(entry['bytes'] for entry in report['files'].values())
        (temporary / 'review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if os.path.lexists(destination):
            raise ValueError('Destination appeared during staging')
        temporary.rename(destination)
        return report
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('--site-id', required=True)
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    report = stage(args.source, args.destination, site_id=args.site_id, origin=args.origin)
    print(json.dumps({'status': report['status'], 'files': len(report['files']),
                      'bytes': report['total_bytes'], 'origin': report['canonical_origin']}))


if __name__ == '__main__':
    main()
