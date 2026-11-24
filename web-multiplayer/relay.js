'use strict';

const http = require('http');
const net = require('node:net');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const MAX_PACKET_BYTES = 4096;
const rooms = new Map();
const browsers = new Set();
let nextRoomId = 1;
let nextPlayerId = 101;
const OPEN = 1;

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('avp relay ready\n');
    return;
  }
  response.writeHead(404);
  response.end();
});

server.on('upgrade', (request, socket, head) => {
  const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
  const key = request.headers['sec-websocket-key'];
  if (request.url !== '/avp' || !key || !protocols.includes('avp-v1')) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    'Sec-WebSocket-Protocol: avp-v1',
    '\r\n'
  ].join('\r\n'));
  const client = { socket, readyState: OPEN, avpPlayer: null, buffer: Buffer.alloc(0), fragments: [], fragmentOpcode: 0, fragmentBytes: 0 };
  socket.on('data', (chunk) => receiveFrames(client, chunk));
  socket.on('close', () => removeClient(client));
  socket.on('end', () => removeClient(client));
  socket.on('error', () => removeClient(client));
  if (head && head.length) receiveFrames(client, head);
});

function sendFrame(client, opcode, payload) {
  if (client.readyState !== OPEN) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  if (client.socket.writableLength > 1024 * 1024) { client.socket.destroy(); return; }
  client.socket.write(Buffer.concat([header, body]));
}

function closeClient(client) {
  if (client.readyState !== OPEN) return;
  client.readyState = 3;
  try { client.socket.end(Buffer.from([0x88, 0x00])); } catch (_) { client.socket.destroy(); }
  removeClient(client);
}

function receiveFrames(client, chunk) {
  if (client.readyState !== OPEN) return;
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0], second = client.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const wideLength = client.buffer.readBigUInt64BE(2);
      if (wideLength > BigInt(MAX_PACKET_BYTES)) return closeClient(client);
      length = Number(wideLength); offset = 10;
    }
    if (!masked || (first & 0x70) || length > MAX_PACKET_BYTES) return closeClient(client);
    if (opcode >= 8 && (!fin || length > 125)) return closeClient(client);
    if (client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    client.buffer = client.buffer.subarray(offset + length);
    if (opcode === 8) return closeClient(client);
    if (opcode === 9) { sendFrame(client, 10, payload); continue; }
    if (opcode === 10) continue;
    if (opcode === 1 || opcode === 2) {
      if (client.fragmentOpcode) return closeClient(client);
      if (!fin) {
        client.fragmentOpcode = opcode;
        client.fragmentBytes = length;
        client.fragments = [payload];
        continue;
      }
      handleMessage(client, opcode, payload);
      continue;
    }
    if (opcode === 0 && client.fragmentOpcode) {
      client.fragmentBytes += length;
      if (client.fragmentBytes > MAX_PACKET_BYTES || client.fragments.length >= 128) return closeClient(client);
      client.fragments.push(payload);
      if (fin) {
        const assembled = Buffer.concat(client.fragments);
        const originalOpcode = client.fragmentOpcode;
        client.fragments = []; client.fragmentOpcode = 0;
        if (assembled.length > MAX_PACKET_BYTES) return closeClient(client);
        handleMessage(client, originalOpcode, assembled);
      }
    } else {
      return closeClient(client);
    }
  }
}

function sendJson(client, object) {
  sendFrame(client, 1, JSON.stringify(object));
}

// The numerical constants match the portable DirectPlay facade in src/fixer.h.
const SYSTEM = 18, ALL = 20, CREATE = 3, DESTROY = 19, HOST = 6;
function playerEvent(type, player) {
  const name = Buffer.from(player.name).subarray(0, 12);
  const frame = Buffer.alloc(22 + name.length);
  frame.writeInt32LE(SYSTEM);
  frame.writeInt32LE(ALL, 4);
  frame.writeInt32LE(type, 8);
  frame.writeInt32LE(player.id, 12);
  frame.writeInt32LE(4, 16); // DPPLAYERTYPE_PLAYER
  frame.writeUInt16LE(name.length, 20);
  name.copy(frame, 22);
  return frame;
}

function removeClient(client) {
  browsers.delete(client);
  const player = client.avpPlayer;
  if (!player) return;
  client.avpPlayer = null;
  const room = player.room;
  room.members.delete(player.id);
  if (room.members.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.host === player.id) {
      const successor = room.members.values().next().value;
      room.host = successor.id;
      const frame = Buffer.alloc(12);
      frame.writeInt32LE(SYSTEM);
      frame.writeInt32LE(ALL, 4);
      frame.writeInt32LE(HOST, 8);
      // Promote before removal. Only the host removes departed players in pldnet.c.
      sendFrame(successor.client, 2, frame);
    }
    const frame = playerEvent(DESTROY, player);
    for (const peer of room.members.values()) sendFrame(peer.client, 2, frame);
  }
  refreshBrowsers();
}

function listRooms(client) {
  const visible = [];
  for (const room of rooms.values()) {
    visible.push({
      id: room.id, name: room.name, players: room.members.size, maxPlayers: room.maxPlayers,
      level: room.level, gameType: room.gameType, customLevel: room.customLevel
    });
    if (visible.length === 10) break; // MAX_NO_OF_SESSIONS
  }
  sendJson(client, {op: 'sessions', rooms: visible});
}

function refreshBrowsers() {
  for (const client of browsers) listRooms(client);
}

function handleControl(client, request) {
  if (request.op === 'leave') { removeClient(client); return; }
  if (client.avpPlayer) {
    sendJson(client, {op: 'error', message: 'Already in a room'});
    return;
  }
  if (request.op === 'list') {
    browsers.add(client);
    listRooms(client);
    return;
  }
  const host = request.op === 'host';
  if ((!host && request.op !== 'join') || request.version !== 100) {
    sendJson(client, {op: 'error', message: 'Incompatible request'});
    return;
  }
  let room;
  const playerId = nextPlayerId++;
  if (host) {
    if (!Number.isInteger(request.gameType) || request.gameType < 0 || request.gameType > 5 ||
        !Number.isInteger(request.level) || request.level < 0 || request.level > 255) {
      sendJson(client, {op: 'error', message: 'Invalid game mode or level'});
      return;
    }
    room = {
      id: nextRoomId++, host: playerId, members: new Map(),
      name: String(request.sessionName || 'AVP Game').slice(0, 24),
      maxPlayers: Math.max(1, Math.min(8, Number(request.players) | 0)),
      gameType: request.gameType, level: request.level,
      customLevel: String(request.customLevel || '').slice(0, 99)
    };
    rooms.set(room.id, room);
  } else {
    room = rooms.get(request.room);
    if (!room || room.members.size >= room.maxPlayers) {
      sendJson(client, {op: 'error', message: room ? 'Room is full' : 'Room has closed'});
      return;
    }
  }
  browsers.delete(client);
  const player = {id: playerId, name: String(request.name || 'Player').slice(0, 12), client, room};
  client.avpPlayer = player;
  sendJson(client, {op: host ? 'created' : 'joined', room: room.id, playerId});
  const announce = playerEvent(CREATE, player);
  for (const peer of room.members.values()) {
    sendFrame(client, 2, playerEvent(CREATE, peer));
    sendFrame(peer.client, 2, announce);
  }
  room.members.set(player.id, player);
  refreshBrowsers();
}

function handleMessage(client, opcode, data) {
  if (opcode === 1) {
    try { handleControl(client, JSON.parse(data.toString('utf8'))); }
    catch (_) { sendJson(client, {op: 'error', message: 'Malformed control message'}); }
    return;
  }
  const player = client.avpPlayer;
  if (opcode !== 2 || !player || data.length <= 18 || data.length > 8 + 3072) return;
  if (data.readInt32LE(0) !== player.id) return;
  const recipient = data.readInt32LE(4);
  for (const peer of player.room.members.values()) {
    if (peer !== player && (recipient === ALL || recipient === peer.id)) sendFrame(peer.client, 2, data);
  }
}

// The LAN listener forwards to the same rooms used by localhost tabs.
// Piping the TCP stream preserves the existing WebSocket upgrade and framing.
const listener = process.argv[3] === '--forward-local' ? net.createServer(client => {
  const upstream = net.connect(PORT, '127.0.0.1');
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.on('close', () => upstream.destroy());
  client.pipe(upstream).pipe(client);
}) : server;
listener.listen(PORT, process.argv[2] || process.env.HOST || '127.0.0.1', () => {
  process.stdout.write(`AVP WebSocket relay listening on :${listener.address().port}\n`);
});
