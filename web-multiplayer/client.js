// Emscripten imports for the browser build. The engine polls these on its normal frame loop.
var avpClientLibrary = {
  $AvpRelay: {
    socket: null,
    player: 0,
    packets: [],
    rooms: [],
    roomsChanged: false,
    error: '',
    timer: 0,

    fail: function (message) {
      AvpRelay.close();
      AvpRelay.error = message;
    },
    close: function () {
      clearTimeout(AvpRelay.timer);
      var socket = AvpRelay.socket;
      AvpRelay.socket = null;
      if (socket) socket.close();
      AvpRelay.player = 0;
      AvpRelay.packets = [];
      AvpRelay.rooms = [];
      AvpRelay.roomsChanged = true;
    },
    connect: function (url, request) {
      AvpRelay.close();
      AvpRelay.error = '';
      try {
        if (!url) {
          url = location.protocol === 'https:' ? 'wss://' + location.host + '/avp'
                                               : 'ws://' + location.hostname + ':8080/avp';
        }
        var socket = new WebSocket(url, 'avp-v1');
        AvpRelay.socket = socket;
        socket.binaryType = 'arraybuffer';
        AvpRelay.timer = setTimeout(function () {
          if (socket === AvpRelay.socket) AvpRelay.fail('Relay timed out');
        }, 15000);
        socket.onopen = function () {
          if (socket === AvpRelay.socket) socket.send(JSON.stringify(request));
        };
        socket.onmessage = function (event) {
          if (socket !== AvpRelay.socket) return;
          if (typeof event.data === 'string') {
            try {
              var msg = JSON.parse(event.data);
              if (msg.op === 'sessions') {
                AvpRelay.rooms = msg.rooms;
                AvpRelay.roomsChanged = true;
              } else if (msg.op === 'created' || msg.op === 'joined') {
                AvpRelay.player = msg.playerId;
              } else {
                AvpRelay.fail(msg.message || 'Unexpected relay response');
              }
              clearTimeout(AvpRelay.timer);
            } catch (err) {
              AvpRelay.fail('Invalid relay response');
            }
          } else if (event.data.byteLength > 4096 || AvpRelay.packets.length >= 1024) {
            AvpRelay.fail('Incoming packet queue exceeded');
          } else {
            AvpRelay.packets.push(new Uint8Array(event.data));
          }
        };
        socket.onerror = socket.onclose = function () {
          if (socket === AvpRelay.socket) AvpRelay.fail('Connection to relay lost');
        };
        return 1;
      } catch (err) {
        AvpRelay.fail('Unable to connect to relay');
        return 0;
      }
    }
  },

  avp_ws_list__deps: ['$AvpRelay', '$UTF8ToString'],
  avp_ws_list: function (url) {
    return AvpRelay.connect(UTF8ToString(url), {op: 'list'});
  },
  avp_ws_host__deps: ['$AvpRelay', '$UTF8ToString'],
  avp_ws_host: function (url, player, session, limit, mode, level, custom) {
    return AvpRelay.connect(UTF8ToString(url), {
      op: 'host', version: 100, name: UTF8ToString(player), sessionName: UTF8ToString(session),
      players: limit, gameType: mode, level: level, customLevel: UTF8ToString(custom)
    });
  },
  avp_ws_join__deps: ['$AvpRelay', '$UTF8ToString'],
  avp_ws_join: function (url, player, room) {
    return AvpRelay.connect(UTF8ToString(url), {
      op: 'join', version: 100, name: UTF8ToString(player), room: room
    });
  },
  avp_ws_close__deps: ['$AvpRelay'],
  avp_ws_close: function () { AvpRelay.close(); },
  avp_ws_player__deps: ['$AvpRelay'],
  avp_ws_player: function () { return AvpRelay.error ? -1 : AvpRelay.player; },
  avp_ws_error__deps: ['$AvpRelay', '$stringToUTF8'],
  avp_ws_error: function (message, capacity) {
    stringToUTF8(AvpRelay.error, message, capacity);
  },
  avp_ws_rooms_changed__deps: ['$AvpRelay'],
  avp_ws_rooms_changed: function () {
    var changed = AvpRelay.roomsChanged;
    AvpRelay.roomsChanged = false;
    return changed;
  },
  avp_ws_room__deps: ['$AvpRelay', '$stringToUTF8'],
  avp_ws_room: function (index, values, name, nameSize, custom, customSize) {
    var room = AvpRelay.rooms[index];
    if (!room) return 0;
    HEAP32.set([room.id, room.players, room.maxPlayers, room.gameType, room.level], values >> 2);
    stringToUTF8(room.name, name, nameSize);
    stringToUTF8(room.customLevel, custom, customSize);
    return 1;
  },
  avp_ws_receive__deps: ['$AvpRelay'],
  avp_ws_receive: function (buffer, capacity) {
    var packet = AvpRelay.packets.shift();
    if (!packet || packet.length > capacity) return 0;
    HEAPU8.set(packet, buffer);
    return packet.length;
  },
  avp_ws_send__deps: ['$AvpRelay'],
  avp_ws_send: function (buffer, size) {
    var socket = AvpRelay.socket;
    if (!socket || socket.readyState !== 1) return -1;
    if (socket.bufferedAmount > 256 * 1024) return 0;
    socket.send(HEAPU8.subarray(buffer, buffer + size));
    return 1;
  }
};

if (typeof addToLibrary === "function") addToLibrary(avpClientLibrary);
else mergeInto(LibraryManager.library, avpClientLibrary);
