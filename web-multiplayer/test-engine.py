"""Build the asset-free Wasm session fixture, then run it against the relay."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
emcc = os.environ.get("EMCC") or shutil.which("emcc")
if not emcc:
    sys.exit("Activate an Emscripten SDK or set EMCC to the path of emcc.py.")
compiler = [sys.executable, emcc] if emcc.endswith(".py") else [emcc]
includes = ["src", "src/include", "src/avp", "src/win95", "src/avp/win95",
            "src/avp/win95/frontend", "src/avp/support", "src/avp/win95/gadgets"]
port = int(os.environ.get("AVP_TEST_PORT", "18080"))

with tempfile.TemporaryDirectory(prefix="avp-wasm-") as directory:
    module = Path(directory, "engine.js")
    # The monolithic gameplay dispatcher also references audio, AI and rendering.
    # Those subsystems are excluded from this session-only executable.
    subprocess.run([
        *compiler, "-O1", "-DNDEBUG", "-DUSE_OPENGL_ES=1",
        f'-DAVP_WEB_MULTIPLAYER_URL="ws://127.0.0.1:{port}/avp"',
        *["-I" + path for path in includes],
        "src/net_websocket.c", "src/avp/win95/pldnet.c", "web-multiplayer/engine-test.c",
        "--js-library", "web-multiplayer/client.js", "-sMODULARIZE=1",
        "-sERROR_ON_UNDEFINED_SYMBOLS=0", "-sWARN_ON_UNDEFINED_SYMBOLS=0",
        "-Wl,--unresolved-symbols=ignore-all", "-o", str(module)
    ], check=True, cwd=root)
    subprocess.run(["node", "web-multiplayer/smoke-test.js", str(module)], check=True, cwd=root)
