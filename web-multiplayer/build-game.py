"""Compile the game with Emscripten and package the user's installed game data."""
import argparse
import concurrent.futures
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'build-web'
NATIVE_ONLY = {
    'src/bink.c', 'src/net.c', 'src/winfiles.c', 'src/main.c', 'src/sdl12/sdlmain.m',
}


def package_assets(data, sdk):
    files = []
    for name in ('avp_huds', 'avp_rifs', 'fastfile', 'Text'):
        folder = data / name
        if not folder.is_dir():
            raise SystemExit('Missing game data directory: ' + str(folder))
        files.extend(sorted(f for f in folder.rglob('*') if f.is_file()))
    for name in ('language.txt', 'default.cfg', 'CREDITS.txt', 'CD Tracks.txt'):
        path = data / name
        if path.is_file():
            files.append(path)
    packager = sdk / 'tools' / 'file_packager.py'
    # The Steam installation mixes cases. The engine retries its reads in lowercase.
    mappings = [str(f) + '@/avp/' + f.relative_to(data).as_posix().lower() for f in files]
    os.chdir(str(OUTPUT))
    sys.path.insert(0, str(packager.parent))
    sys.argv = [str(packager), 'avp.data', '--preload'] + mappings + ['--js-output=assets.js', '--no-node']
    result = runpy.run_path(str(packager))['main']()
    if result:
        raise SystemExit(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('steam_folder', type=Path)
    parser.add_argument('--emcc', type=Path, default=os.environ.get('EMCC'),
                        help='Path to emcc.py in the Emscripten installation')
    args = parser.parse_args()
    emcc = args.emcc
    if emcc is None:
        driver = shutil.which('emcc')
        if driver:
            emcc = Path(driver).resolve().with_name('emcc.py')
    if emcc is None or not emcc.is_file():
        parser.error('Supply --emcc pointing to emcc.py')
    sdk = emcc.resolve().parent
    config = sdk.parent / '.emscripten'
    if config.is_file():
        os.environ.setdefault('EM_CONFIG', str(config))
    data = args.steam_folder.resolve()
    if not (data / 'fastfile' / 'ffinfo.txt').is_file():
        parser.error('The Steam folder must contain fastfile/ffinfo.txt')
    os.chdir(str(ROOT))
    OUTPUT.mkdir(exist_ok=True)
    cmake = (ROOT / 'CMakeLists.txt').read_text()
    manifest = re.findall(r'^\s*LIST\(APPEND source (src/[^ )]+)\)', cmake, re.M)
    sources = list(dict.fromkeys(f for f in manifest if f not in NATIVE_ONLY))
    if 'src/bink_web.c' not in sources:
        sources.append('src/bink_web.c')
    include = ['-Isrc/include'] + ['-I' + d for d in sorted({str(Path(f).parent) for f in sources})]
    flags = ['-O0', '-DNDEBUG', '-DAVP_WEB_BUILTIN_SDL=1', '-DUSE_OPENGL_ES=1', '-fno-common',
             '-sUSE_SDL=1', '-Wno-error=implicit-function-declaration', '-Wno-error=int-conversion',
             '-Wno-error=incompatible-function-pointer-types', '-Wno-error=incompatible-pointer-types']

    with tempfile.TemporaryDirectory(prefix='avp-wasm-') as tmp:
        def compile_source(source):
            cpp = source.endswith('.cpp')
            driver = sdk / ('em++.py' if cpp else 'emcc.py')
            obj = Path(tmp) / (source.replace('/', '_') + '.o')
            language_flags = ['-std=gnu++98', '-fno-strict-aliasing'] if cpp else []
            command = [sys.executable, str(driver)] + include + flags + language_flags
            result = subprocess.run(command + ['-c', source, '-o', str(obj)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(result.stdout.decode(errors='replace'))
            return obj

        print('Compiling {} game sources'.format(len(sources)), flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, os.cpu_count() or 1)) as pool:
            objects = list(pool.map(compile_source, sources))
        response = Path(tmp) / 'objects.rsp'
        response.write_text('\n'.join('"' + p.as_posix() + '"' for p in objects))
        subprocess.run([sys.executable, str(sdk / 'em++.py'), '@' + str(response), '-O0', '-g2',
                        '-sUSE_SDL=1', '-sINITIAL_MEMORY=234881024', '-sSTACK_SIZE=5242880',
                        '-sALLOW_MEMORY_GROWTH=1', '-sFORCE_FILESYSTEM=1', '-sENVIRONMENT=web',
                        '-sEXPORTED_RUNTIME_METHODS=FS,ENV,FS_createPath,FS_createDataFile,addRunDependency,removeRunDependency',
                        '-lopenal', '--js-library', 'web-multiplayer/client.js', '-o', str(OUTPUT / 'avp.js')], check=True)
    package_assets(data, sdk)
    shutil.copy2(str(ROOT / 'web-multiplayer/game.html'), str(OUTPUT / 'index.html'))
    print('Built ' + str(OUTPUT / 'index.html'))


if __name__ == '__main__':
    main()
