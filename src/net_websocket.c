#include "fixer.h"
#include "3dc.h"
#include "gamedef.h"
#include "inline.h"
#include "module.h"
#include "stratdef.h"
#include "equipmnt.h"
#include "platform.h"
#include "pldnet.h"
#include "net.h"
#include "avp_menus.h"
#include "avp_mp_config.h"

#ifndef AVP_WEB_MULTIPLAYER_URL
#define AVP_WEB_MULTIPLAYER_URL ""
#endif

/* Browser imports in web-multiplayer/client.js. Only the menu and game frame
 * loops touch game state. WebSocket callbacks retain copies until polled. */
extern int avp_ws_list(const char *url);
extern int avp_ws_join(const char *url, const char *player, int room);
extern int avp_ws_host(const char *url, const char *player, const char *session,
                       int limit, int mode, int level, const char *custom);
extern void avp_ws_close(void);
extern int avp_ws_player(void);
extern void avp_ws_error(char *message, int capacity);
extern int avp_ws_rooms_changed(void);
typedef struct { int id, players, limit, mode, level; } RelayRoom;
extern int avp_ws_room(int index, RelayRoom *room, char *name, int nameSize,
                       char *custom, int customSize);
extern int avp_ws_send(const void *data, int size);
extern int avp_ws_receive(void *buffer, int capacity);

DPID AVPDPNetID;
DPNAME AVPDPplayerName;
int QuickStartMultiplayer = 1;
int glpDP;

static struct { int host, species, mode, level; unsigned int began; } pending;
static struct { DPID id; char name[NET_PLAYERNAMELENGTH]; } players[NET_MAXPLAYERS];
static unsigned char incoming[4096], outgoing[NET_MESSAGEBUFFERSIZE + 8];
static DPMSG_CREATEPLAYERORGROUP created;
static DPMSG_DESTROYPLAYERORGROUP destroyed;
static DPMSG_GENERIC systemEvent;
static char statusText[96];
static int descriptionTimedOut;

char *NetWebStatus(void)
{
    if (descriptionTimedOut) return "Timed out waiting for game description";
    avp_ws_error(statusText, sizeof(statusText));
    return statusText;
}

BOOL DpExtInit(DWORD buffers, DWORD bytes, BOOL checks) { return TRUE; }
void DpExtUnInit(void) { /* EndAVPNetGame still has a final message to send. */ }

int DirectPlay_Disconnect(void)
{
    avp_ws_close();
    memset(players, 0, sizeof(players));
    AVPDPNetID = glpDP = 0;
    AvP.Network = I_No_Network;
    AvP.NetworkAIServer = 0;
    return 1;
}

static void BeginRegistration(char *name)
{
    AVPDPplayerName.dwSize = sizeof(DPNAME);
    AVPDPplayerName.lpszShortNameA = AVPDPplayerName.lpszLongNameA = name;
    descriptionTimedOut = 0;
    pending.began = GetTickCount();
    netGameData.joiningGameStatus = JOINNETGAME_WAITFORDESC;
}

int DirectPlay_HostGame(char *name, char *session, int species, int mode, int level)
{
    extern int DetermineAvailableCharacterTypes(int);
    DirectPlay_Disconnect();
    BeginRegistration(name);
    if (netGameData.skirmishMode) {
        AVPDPNetID = 100;
        InitAVPNetGameForHost(species, mode, level);
        return 1;
    }
    pending.host = 1;
    pending.species = species;
    pending.mode = mode;
    pending.level = level;
    return avp_ws_host(AVP_WEB_MULTIPLAYER_URL, name, session,
                       DetermineAvailableCharacterTypes(FALSE), mode, level,
                       GetCustomMultiplayerLevelName(level, mode));
}

void DirectPlay_EnumConnections(void)
{
    netGameData.tcpip_available = 1;
    netGameData.modem_available = netGameData.ipx_available = netGameData.serial_available = 0;
}

int DirectPlay_JoinGame(void)
{
    DirectPlay_Disconnect();
    descriptionTimedOut = 0;
    NumberOfSessionsFound = 0;
    return avp_ws_list(AVP_WEB_MULTIPLAYER_URL);
}

BOOL DirectPlay_UpdateSessionList(int *selected)
{
    if (!avp_ws_rooms_changed()) return FALSE;
    int oldId = (*selected >= 0 && *selected < NumberOfSessionsFound) ? SessionData[*selected].Guid : 0;
    NumberOfSessionsFound = 0;
    *selected = 0;
    for (int i = 0; NumberOfSessionsFound < MAX_NO_OF_SESSIONS; i++) {
        RelayRoom room;
        char name[32], custom[100];
        if (!avp_ws_room(i, &room, name, sizeof(name), custom, sizeof(custom))) break;
        int level = GetLocalMultiplayerLevelIndex(room.level, custom, room.mode);
        if (level < 0) continue;
        SESSION_DESC *session = &SessionData[NumberOfSessionsFound];
        snprintf(session->Name, sizeof(session->Name), "%.24s (%d/%d)", name, room.players, room.limit);
        session->Guid = room.id;
        session->levelIndex = level;
        session->AllowedToJoin = room.players < room.limit;
        if (room.id == oldId) *selected = NumberOfSessionsFound;
        NumberOfSessionsFound++;
    }
    return TRUE;
}

int DirectPlay_ConnectToSession(int index, char *name)
{
    if (index < 0 || index >= NumberOfSessionsFound || !SessionData[index].AllowedToJoin) return 0;
    BeginRegistration(name);
    pending.host = 0;
    pending.level = SessionData[index].levelIndex;
    return avp_ws_join(AVP_WEB_MULTIPLAYER_URL, name, SessionData[index].Guid);
}

int DirectPlay_ConnectingToSession(void)
{
    extern unsigned char DebouncedKeyboardInput[];
    int id = avp_ws_player();
    descriptionTimedOut = GetTickCount() - pending.began > 30000u;
    if (DebouncedKeyboardInput[KEY_ESCAPE] || id < 0 || descriptionTimedOut) {
        DirectPlay_Disconnect();
        return 0;
    }
    if (!id) return 1;
    if (!glpDP) {
        glpDP = 1;
        AVPDPNetID = id;
        if (pending.host) {
            InitAVPNetGameForHost(pending.species, pending.mode, pending.level);
            return AVPMENU_MULTIPLAYERSTARTGAME;
        }
        InitAVPNetGameForJoin();
        netGameData.levelNumber = pending.level;
        netGameData.joiningGameStatus = JOINNETGAME_WAITFORDESC;
    }
    MinimalNetCollectMessages();
    if (AvP.Network != I_Peer) {
        DirectPlay_Disconnect();
        return 0;
    }
    return netGameData.needGameDescription ? 1 : AVPMENU_MULTIPLAYER_CONFIG_JOIN;
}

int DirectPlay_ConnectingToLobbiedGame(char *name) { return 0; }

HRESULT DpExtSend(int dp, DPID from, DPID to, DWORD flags, void *data, DWORD size)
{
    if (!data || !from || from != AVPDPNetID) return DPERR_INVALIDPARAMS;
    if (size > NET_MESSAGEBUFFERSIZE) return DPERR_SENDTOOBIG;
    memcpy(outgoing, &from, 4);
    memcpy(outgoing + 4, &to, 4);
    memcpy(outgoing + 8, data, size);
    int sent = avp_ws_send(outgoing, size + 8);
    if (sent < 0) return DPERR_CONNECTIONLOST;
    return sent ? DP_OK : DPERR_BUSY;
}

static int DecodeSystemEvent(unsigned char *data, unsigned int size, void **result)
{
    if (size < 4) return 0;
    memcpy(&systemEvent.dwType, data, 4);
    if (systemEvent.dwType == DPSYS_HOST && size == 4) {
        *result = &systemEvent;
        return sizeof(systemEvent);
    }
    if (size < 14) return 0;
    DPID id;
    unsigned short length;
    memcpy(&id, data + 4, 4);
    memcpy(&length, data + 12, 2);
    if (length >= NET_PLAYERNAMELENGTH || size != 14u + length) return 0;
    for (int i = 0; i < NET_MAXPLAYERS; i++) {
        if (systemEvent.dwType == DPSYS_CREATEPLAYERORGROUP && !players[i].id) {
            players[i].id = id;
            memcpy(players[i].name, data + 14, length);
            players[i].name[length] = 0;
            created.dwType = DPSYS_CREATEPLAYERORGROUP;
            created.dwPlayerType = DPPLAYERTYPE_PLAYER;
            created.dpId = id;
            created.dpnName.dwSize = sizeof(DPNAME);
            created.dpnName.lpszShortNameA = created.dpnName.lpszLongNameA = players[i].name;
            *result = &created;
            return sizeof(created);
        }
        if (systemEvent.dwType == DPSYS_DESTROYPLAYERORGROUP && players[i].id == id) {
            players[i].id = 0;
            destroyed.dwType = DPSYS_DESTROYPLAYERORGROUP;
            destroyed.dwPlayerType = DPPLAYERTYPE_PLAYER;
            destroyed.dpId = id;
            *result = &destroyed;
            return sizeof(destroyed);
        }
    }
    return 0;
}

HRESULT DpExtRecv(int dp, void *from, void *to, DWORD flags, void *data, LPDWORD size)
{
    if (!from || !to || !data || !size) return DPERR_INVALIDPARAMS;
    if (glpDP && avp_ws_player() < 0) {
        glpDP = 0;
        AvP.MainLoopRunning = 0;
        systemEvent.dwType = DPSYS_SESSIONLOST;
        *(DPID *)from = DPID_SYSMSG;
        *(DPID *)to = AVPDPNetID;
        *(void **)data = &systemEvent;
        *size = sizeof(systemEvent);
        return DP_OK;
    }
    int length = avp_ws_receive(incoming, sizeof(incoming));
    if (length < 8) return 1;
    memcpy(from, incoming, 4);
    memcpy(to, incoming + 4, 4);
    *size = length - 8;
    if (*(DPID *)from == DPID_SYSMSG) {
        *size = DecodeSystemEvent(incoming + 8, *size, (void **)data);
        if (!*size) return 1;
    } else {
        if (*size <= DPEXT_HEADER_SIZE || *size > NET_MESSAGEBUFFERSIZE) return 1;
        *(void **)data = incoming + 8;
    }
    return DP_OK;
}

HRESULT IDirectPlayX_GetPlayerName(int dp, DPID id, void *data, void *size)
{
    if (!size || !id) return DPERR_INVALIDPARAMS;
    const char *name = id == AVPDPNetID ? AVPDPplayerName.lpszShortNameA : NULL;
    for (int i = 0; !name && i < NET_MAXPLAYERS; i++)
        if (players[i].id == id) name = players[i].name;
    if (!name) return DPERR_INVALIDPLAYER;
    DWORD required = sizeof(DPNAME) + strlen(name) + 1;
    DWORD supplied = *(DWORD *)size;
    *(DWORD *)size = required;
    if (!data || supplied < required) return DPERR_BUFFERTOOSMALL;
    DPNAME *player = data;
    player->dwSize = sizeof(DPNAME);
    player->lpszShortNameA = player->lpszLongNameA = (char *)(player + 1);
    strcpy(player->lpszShortNameA, name);
    return DP_OK;
}
