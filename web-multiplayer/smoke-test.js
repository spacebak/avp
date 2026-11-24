'use strict';

const assert = require('assert');
const { spawn } = require('child_process');

const PORT = Number(process.env.AVP_TEST_PORT || 18080);
const URL = `ws://127.0.0.1:${PORT}/avp`;

function startRelay() {
  const relay = spawn(process.execPath, [require.resolve('./relay.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Relay did not start')), 3000);
    relay.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('listening on')) { clearTimeout(timer); resolve(relay); }
    });
    relay.once('error', (error) => { clearTimeout(timer); reject(error); });
    relay.once('exit', (code) => {
      if (!output.includes('listening on')) {
        clearTimeout(timer);
        reject(new Error(`Relay exited before startup (code ${code})`));
      }
    });
  });
}

function connect() {
  const socket = new WebSocket(URL, 'avp-v1');
  const messages = [];
  const waiters = [];
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    const binary = typeof event.data !== 'string';
    const value = binary
      ? Buffer.from(event.data)
      : JSON.parse(event.data);
    messages.push({ binary, value });
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(messages[messages.length - 1])) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(messages.pop());
        break;
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    socket,
    opened,
    waitFor(predicate, timeoutMs = 3000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error('Timed out waiting for relay message'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

function control(message) { return !message.binary && message.value.op; }
function isSystem(message, type, playerId) {
  return message.binary && message.value.readInt32LE(0) === 18 &&
    message.value.readUInt32LE(8) === type && message.value.readUInt32LE(12) === playerId;
}

async function runEngineFixture(path) {
  const createGame = require(path);
  const wasmBinary = require('fs').readFileSync(path.replace(/\.js$/, '.wasm'));
  const [host, guest] = await Promise.all([createGame({ wasmBinary }), createGame({ wasmBinary })]);
  async function until(label, ready) {
    const end = Date.now() + 5000;
    while (!ready()) {
      if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    for (let mode = 0; mode < 6; mode++) {
      assert(host._host(mode));
      await until('host registration', () => host._poll_host());
      assert(guest._list());
      await until('room listing', () => guest._listed());
      assert(guest._join());
      await until('game description', () => {
        host._frame();
        return guest._poll_guest();
      });
      assert(guest._synced(mode), 'Mode, roster, equipment or game settings differ');
      guest._choose();
      await until('guest specialist', () => host._chosen());
      host._send_scores();
      await until('team scores', () => guest._received_scores());
      guest._leave();
      host._leave();
    }
    console.log('PASS: six modes, host species, roster, equipment, specialist selection and team scores through pldnet.c');
  } finally {
    guest._leave();
    host._leave();
  }
}

async function main() {
  const relay = await startRelay();
  if (process.argv[2]) {
    try { await runEngineFixture(process.argv[2]); }
    finally { relay.kill(); }
    return;
  }
  const clients = Array.from({ length: 5 }, connect);
  const [host, guest, third, observer, outsider] = clients;
  const send = (client, request) => client.socket.send(JSON.stringify(request));
  const wait = (client, op) => client.waitFor(m => control(m) === op).then(m => m.value);
  const join = async (client, room, name) => {
    send(client, {op: 'join', version: 100, room, name});
    return (await wait(client, 'joined')).playerId;
  };
  const gamePacket = (from, to, value) => {
    const frame = Buffer.alloc(19);
    frame.writeInt32LE(from);
    frame.writeInt32LE(to, 4);
    frame[18] = value;
    return frame;
  };
  const receives = (packet) => m => m.binary && m.value.equals(packet);
  try {
    await Promise.all(clients.map(c => c.opened));
    send(observer, {op: 'list'});
    assert.deepStrictEqual((await wait(observer, 'sessions')).rooms, []);
    const title = 'Lab "A" }';
    send(host, {op:'host', name:'Host', sessionName:title, players:3, gameType:4, level:7, customLevel:'Lab', version:100});
    const {room, playerId: hostId} = await wait(host, 'created');
    const listing = (await wait(observer, 'sessions')).rooms[0];
    assert.deepStrictEqual(listing, {id:room, name:title, players:1, maxPlayers:3, gameType:4, level:7, customLevel:'Lab'});
    const guestId = await join(guest, room, 'Guest');
    await host.waitFor(m => isSystem(m, 3, guestId));
    await guest.waitFor(m => isSystem(m, 3, hostId));
    const thirdId = await join(third, room, 'Third');
    await host.waitFor(m => isSystem(m, 3, thirdId));
    send(outsider, {op:'join', version:100, room, name:'Fourth'});
    assert.match((await wait(outsider, 'error')).message, /full/);
    send(outsider, {op:'host', version:100, name:'Elsewhere', players:2, level:0, gameType:0});
    await wait(outsider, 'created');

    const directed = gamePacket(hostId, guestId, 41);
    const broadcast = gamePacket(hostId, 20, 42);
    host.socket.send(directed);
    host.socket.send(broadcast);
    await guest.waitFor(receives(directed));
    await Promise.all([guest, third].map(c => c.waitFor(receives(broadcast))));
    await assert.rejects(third.waitFor(receives(directed), 80), /Timed out/);
    await assert.rejects(outsider.waitFor(receives(broadcast), 80), /Timed out/);

    host.socket.close();
    await guest.waitFor(m => m.binary && m.value.length === 12 && m.value.readInt32LE(8) === 6);
    await Promise.all([guest, third].map(c => c.waitFor(m => isSystem(m, 19, hostId))));
    await assert.rejects(third.waitFor(m => m.binary && m.value.length === 12 && m.value.readInt32LE(8) === 6, 80), /Timed out/);
    third.socket.close();
    await guest.waitFor(m => isSystem(m, 19, thirdId));
    guest.socket.close();
    await observer.waitFor(m => control(m) === 'sessions' && m.value.rooms.every(r => r.id !== room));
    process.stdout.write('PASS: live discovery, capacity, roster, routing, room isolation, migration and cleanup\n');
  } finally {
    for (const c of clients) c.socket.close();
    relay.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
