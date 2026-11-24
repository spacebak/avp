# Browser multiplayer

The WEB build uses a browser WebSocket and a Node.js room relay. One game client runs the host simulation. The relay tracks rooms and player identities and routes packets. The game's existing C code handles species, equipment, AI, scoring and match rules. [Emscripten networking](https://emscripten.org/docs/porting/networking.html)

## Run locally

With Node.js 22 or newer, start the relay from the repository root.

```sh
node web-multiplayer/relay.js
```

The default endpoint is `ws://localhost:8080/avp`. Open two instances of the web game. In **Multiplayer**, choose **Host New Game** in one, select a mode and level, and start the session. In the other, choose **Join Existing Game**, select the room, then choose a species and enter the match. The host must keep the game running while the guest joins. Skirmish runs offline.

For a shared deployment, point all clients at the same relay. Configure `AVP_WEB_MULTIPLAYER_URL` when building, for example with `-DAVP_WEB_MULTIPLAYER_URL=wss://games.example.org/avp`. Forward WebSocket upgrade requests for `/avp` from the HTTPS server to the relay. The relay binds to `127.0.0.1` by default. Its `HOST` and `PORT` environment variables select the listening address. Rooms are visible to everyone connected to that relay, and the legacy gameplay decoder assumes trusted peers.

## Compile and launch the game

The standalone builder takes the installed Steam game directory and an Emscripten SDK. It compiles the engine, links the WebSocket client and OpenAL, and packages the maps, HUDs, sounds and language files in `build-web`. The generated data package contains files from your own installation. The browser build uses Emscripten’s built-in SDL support and the static menu background. Bink movies and Bink music are disabled.

With the Unity 6000.4.10f1 SDK installed on this machine, run from the repository root in PowerShell:

```powershell
$sdk = "E:/Unity/6000.4.10f1/Editor/Data/PlaybackEngines/WebGLSupport/BuildTools/Emscripten"
& "$sdk/python/python.exe" web-multiplayer/build-game.py --emcc "$sdk/emscripten/emcc.py" "E:/SteamLibrary/steamapps/common/Aliens versus Predator Classic"
.\launch-web.ps1
```

The launcher starts both the game server and the relay on loopback and opens the default browser. To launch a previously compiled game, run `.\launch-web.ps1` alone. Select **New Profile** with Enter. Use arrow keys and Enter in the menus. Click the canvas for mouse capture and press Esc to release it. In this build, profiles and saves last for the current page session.

The standalone builder also accepts a different Steam directory and a path to `emcc.py`. Both players need the same game data. For custom maps the room list matches level names against the local installation.

## Transport and game behavior

- The relay assigns player IDs, advertises room occupancy and enforces the host's player limit up to eight. Background browser callbacks queue incoming data until the game polls on its next frame.
- Text frames carry JSON session commands and results. Binary game frames carry two little-endian 32-bit IDs followed by the original game packet, including its ten-byte reserved DirectPlay extension header. The relay handles broadcasts and addressed packets within each room.
- The adapter translates roster changes into the events expected by `pldnet.c`. When a host disconnects, the relay promotes one remaining player before announcing the departure. Players still in the join menu follow the game's existing host-loss behavior.
- `pldnet.c` implements Deathmatch, Species Deathmatch, Last Man Standing, Predator Tag, Cooperative and Alien Tag. It sends host limits and equipment settings in the game description. The browser adapter feeds those messages through the same handlers, including all nine Marine loadouts. [Gold Edition manual](https://sierrachest.com/gfx/games/AVP_Gold/box/AvP%20Gold%20Manual_Deutsch.pdf)
- Browser rooms use the in-game browser. Windows DirectPlay launcher sessions and Steam lobbies use different protocols.

## Verification

Run the relay regression from the repository root.

```sh
npm --prefix web-multiplayer test
```

With Python, Node.js and Emscripten available, run the session test.

```sh
python web-multiplayer/test-engine.py
```

Set `EMCC` to the path of `emcc.py` if the SDK is outside your PATH. Both tests start and stop their own relay. `AVP_TEST_PORT` defaults to 18080.

The relay test checks live room listings, capacity, player creation and removal, directed and broadcast delivery, room isolation and host election. The session test builds the real `pldnet.c` and web adapter as Wasm and drives two clients through all six modes. It checks host species, player names, Marine specialist selection, host settings and in-game team score messages. The fixture substitutes the map catalog and omits rendering, audio and level simulation. The full build was also playtested using the Steam data in two Brave instances. A Marine hosted Deathmatch on Sewer and a Predator discovered the room, joined and entered the same level. The single-player test loaded Temple and verified movement.
