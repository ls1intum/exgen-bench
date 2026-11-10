#!/usr/bin/env python3
"""Run exgen's Gradle oracle command in an offline container on a dedicated Docker host.

Only a temporary candidate tree enters the container; only bounded, regular report files
leave it: JUnit XML, the JaCoCo XML report, PIT's mutations.xml and the bypass probe's
main transcript. Gradle's own output reaches the host as the last MAX_OUTPUT bytes of each
stream. The unchanged exgen oracle parses them and computes the verdict.
"""
import io
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading

MAX_INPUT = 64 * 1024 * 1024
MAX_REPORTS = 16 * 1024 * 1024
# Bytes of Gradle's stdout and of its stderr passed on to the host; the oracle reads only the tail.
MAX_OUTPUT = 1024 * 1024
# What may leave the container, relative to /workspace/build: (directory, allowed file names or None
# for any *.xml). The mutation and bypass passes of java-oracle >= metric version 2 need the last two.
COPY_BACK = [
    ('test-results/test', None),
    ('reports/jacoco/test', {'jacocoTestReport.xml'}),
    ('reports/pitest', {'mutations.xml'}),
    ('exgen-main', {'stdout.txt', 'exit.txt'}),
]


def interrupted(signum, frame):
    raise KeyboardInterrupt


def copy_back(docker, cid, root, directory, names):
    """Copy bounded regular files of one build directory out of the container, if it exists."""
    # Only the directory's own files are kept, so nested output (test-results' binary/, HTML
    # reports) is left behind rather than counted against the transfer limit.
    proc = subprocess.Popen(docker + ['exec', cid, 'tar', '-cf', '-', f'--exclude={directory}/*/*',
                                      '-C', '/workspace/build', directory],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        raw = proc.stdout.read(MAX_REPORTS + 1)
        if len(raw) > MAX_REPORTS:
            raise ValueError(f'{directory} exceeds its transfer limit')
        if proc.wait(timeout=30) != 0:
            return
        prefix = PurePosixPath(directory).parts
        target = root / 'build' / directory
        total = 0
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            for info in tar:
                parts = PurePosixPath(info.name).parts
                if len(parts) != len(prefix) + 1 or parts[:-1] != prefix or parts[-1] in ('.', '..'):
                    continue
                name = parts[-1]
                if not (name in names if names is not None else name.endswith('.xml')):
                    continue
                if not info.isfile():
                    raise ValueError(f'{directory}/{name} is not a regular file')
                total += info.size
                if total > MAX_REPORTS:
                    raise ValueError(f'{directory} exceeds its expanded limit')
                target.mkdir(parents=True, exist_ok=True)
                (target / name).write_bytes(tar.extractfile(info).read())
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def keep_tail(stream, kept):
    """Read a stream to its end, keeping only its last MAX_OUTPUT bytes."""
    tail = bytearray()
    for chunk in iter(lambda: stream.read(65536), b''):
        tail += chunk
        del tail[:-MAX_OUTPUT]
    kept.append(bytes(tail))


def run_bounded(argv, timeout):
    """Run a command and pass on the tail of its stdout and stderr once it ends."""
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    kept = ([], [])
    readers = [threading.Thread(target=keep_tail, args=(stream, out), daemon=True)
               for stream, out in zip((proc.stdout, proc.stderr), kept)]
    for reader in readers:
        reader.start()
    try:
        return proc.wait(timeout=timeout)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for reader in readers:
            reader.join()
        for out, target in zip(kept, (sys.stdout, sys.stderr)):
            target.buffer.write(out[0] if out else b'')
            target.flush()


def main():
    host = os.environ['EXGEN_ORACLE_DOCKER_HOST']
    image = os.environ['EXGEN_ORACLE_IMAGE']
    if host != 'unix:///run/user/1001/docker.sock' or not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('The dedicated rootless Docker host and immutable image digest are required')
    docker = ['docker', '--host', host]
    version = sys.argv[1:] == ['--version']
    root = Path.cwd()
    archive = io.BytesIO()
    if not version:
        if not root.parent.name.startswith('exgen-oracle-gradle-'):
            raise ValueError('Only an exgen temporary Gradle build tree may be evaluated')
        for directory, _ in COPY_BACK:
            if (root / 'build' / directory).exists():
                shutil.rmtree(root / 'build' / directory)
        total = 0
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for path in sorted(root.rglob('*')):
                if path.is_symlink() or not (path.is_dir() or path.is_file()):
                    raise ValueError('Candidate tree contains an unsupported file')
                info = tar.gettarinfo(str(path), str(path.relative_to(root)))
                total += info.size
                if total > MAX_INPUT or archive.tell() > MAX_INPUT:
                    raise ValueError('Candidate tree exceeds its transfer limit')
                info.uid = info.gid = 1000
                info.uname = info.gname = ''
                info.mode = 0o755 if info.isdir() else 0o644
                if info.isfile():
                    with path.open('rb') as content:
                        tar.addfile(info, content)
                else:
                    tar.addfile(info)
    cid = subprocess.check_output(docker + [
        'create', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g',
        '--memory-swap', '2g', '--cpus', '2', '--user', '1000:1000',
        '--tmpfs', '/workspace:rw,exec,uid=1000,gid=1000,mode=0700,size=512m',
        '--tmpfs', '/tmp:rw,exec,uid=1000,gid=1000,mode=1777,size=1024m',
        '--entrypoint', 'sh', image, '-c', 'sleep 1200'], text=True, timeout=30).strip()
    try:
        subprocess.run(docker + ['start', cid], check=True, stdout=subprocess.DEVNULL, timeout=30)
        if not version:
            subprocess.run(docker + ['exec', '-i', cid, 'tar', '-xf', '-', '-C', '/workspace'], input=archive.getvalue(), check=True, timeout=60)
        command = ('set -eu; cp -a /root/.gradle /tmp/gradle-home; '
                   'export GRADLE_USER_HOME=/tmp/gradle-home; cd /workspace; '
                   'set -- /tmp/gradle-home/wrapper/dists/gradle-*/*/gradle-*/bin/gradle "$@"; '
                   'exec "$@"')
        returncode = run_bounded(docker + ['exec', cid, 'sh', '-c', command, 'isolated-gradle', *sys.argv[1:]], timeout=1000)
        if not version:
            for directory, names in COPY_BACK:
                copy_back(docker, cid, root, directory, names)
        return returncode
    finally:
        subprocess.run(docker + ['rm', '-f', cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
