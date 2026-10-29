#!/usr/bin/env python3
"""Prepare a separate Pages tree without publishing development artifacts.

This does not make files in the public Git repository private.
"""
import argparse
import os
import shutil
import stat
import tempfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
import posixpath


EXCLUDED_ROOTS = frozenset({'.git', 'prototype', 'tests', 'docs', '__pycache__'})
EXCLUDED_FILES = frozenset({'scripts/stage_pages.py'})
REQUIRED_FILES = ('index.html', 'app.js', 'site.js', 'style.css', 'sw.js',
                  'privacy.html', 'sitemap.xml', 'robots.txt', 'manifest.webmanifest')


def excluded(relative):
    parts = PurePosixPath(relative).parts
    return bool(parts) and (parts[0] in EXCLUDED_ROOTS or '__pycache__' in parts or relative in EXCLUDED_FILES)


def validate_source(source):
    for name in REQUIRED_FILES:
        path = source / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Missing required site file: {name}')
    for root, dirs, files in os.walk(source, followlinks=False):
        base = Path(root)
        dirs[:] = [name for name in dirs if not excluded((base / name).relative_to(source).as_posix())]
        for name in dirs + files:
            path = base / name
            relative = path.relative_to(source).as_posix()
            if excluded(relative):
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError(f'Unsupported site entry: {relative}')


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('href', 'src') and value:
                self.urls.append(value)


def validate_html_links(source):
    """Reject references to excluded content from otherwise preserved HTML."""
    for root, dirs, files in os.walk(source, followlinks=False):
        base = Path(root)
        dirs[:] = [name for name in dirs if not excluded((base / name).relative_to(source).as_posix())]
        for name in files:
            if not name.lower().endswith(('.html', '.htm')):
                continue
            path = base / name
            relative = path.relative_to(source).as_posix()
            if excluded(relative):
                continue
            parser = Links()
            parser.feed(path.read_text(encoding='utf-8'))
            for raw in parser.urls:
                url = urlsplit(raw.strip())
                if url.scheme and url.scheme not in ('http', 'https'):
                    continue
                if url.netloc and url.hostname != 'ok-clean.github.io':
                    continue
                if not url.path:
                    continue
                value = unquote(url.path)
                # Browser resolution clamps '..' at the URL root, even from index.html.
                resolved = posixpath.normpath(posixpath.join('/', posixpath.dirname(relative), value)).lstrip('/')
                if excluded(resolved):
                    raise ValueError(f'Preserved HTML references an excluded path: {relative}')


def stage(source_arg, destination_arg):
    source = Path(source_arg).resolve(strict=True)
    if not source.is_dir():
        raise ValueError('Source must be a directory')
    destination = Path(destination_arg).absolute()
    if os.path.lexists(destination):
        raise ValueError('Destination must not exist')
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if source == parent or source in parent.parents:
        raise ValueError('Destination must be outside source')
    validate_source(source)
    validate_html_links(source)
    temporary = Path(tempfile.mkdtemp(prefix='.okclean-stage-', dir=parent))
    try:
        def ignore(directory, names):
            base = Path(directory)
            return [name for name in names if excluded((base / name).relative_to(source).as_posix())]

        # Preserve symlinks in the temporary tree so a race cannot copy targets outside source.
        shutil.copytree(source, temporary, ignore=ignore, symlinks=True, dirs_exist_ok=True)
        validate_source(temporary)
        if os.path.lexists(destination):
            raise ValueError('Destination appeared during staging')
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('destination')
    args = parser.parse_args()
    stage(args.source, args.destination)
    print('Pages staging complete')


if __name__ == '__main__':
    main()
