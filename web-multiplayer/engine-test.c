/* Session-level fixture. Link with the real pldnet.c and net_websocket.c.
 * The map loader, HUD and renderer are outside this test. */
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
#include <emscripten.h>

AVP_GAME_DESC AvP;
SESSION_DESC SessionData[MAX_NO_OF_SESSIONS];
int NumberOfSessionsFound, TimeScale;
unsigned char DebouncedKeyboardInput[MAX_NUMBER_OF_INPUT_KEYS];

unsigned int GetTickCount(void) { return (unsigned int)emscripten_get_now(); }
char *GetTextString(enum TEXTSTRING_ID id) { return NULL; }
void *AllocMem(size_t size) { return malloc(size); }
void DeallocMem(void *ptr) { free(ptr); }
char *GetCustomMultiplayerLevelName(int level, int mode) { return ""; }
int GetLocalMultiplayerLevelIndex(int level, char *name, int mode) { return level; }

extern void GetNextAllowedSpecies(int *species, BOOL forwards);
extern int DirectPlay_HostGame(char *, char *, int, int, int);
extern int DirectPlay_JoinGame(void);
extern int DirectPlay_ConnectToSession(int, char *);
extern BOOL DirectPlay_UpdateSessionList(int *);

EMSCRIPTEN_KEEPALIVE int host(int mode)
{
    int species = 4; /* smartgun specialist unless the mode assigns the host */
    netGameData.preDestroyLights = 1;
    netGameData.allowFlamer = 0;
    netGameData.scoreLimit = 271;
    netGameData.gameType = mode;
    GetNextAllowedSpecies(&species, TRUE);
    return DirectPlay_HostGame("Host", "Lab \"A\" }", species, mode, 1);
}

EMSCRIPTEN_KEEPALIVE int list(void) { return DirectPlay_JoinGame(); }

EMSCRIPTEN_KEEPALIVE int listed(void)
{
    int selected = 0;
    DirectPlay_UpdateSessionList(&selected);
    return NumberOfSessionsFound == 1 && !strcmp(SessionData[0].Name, "Lab \"A\" } (1/8)");
}

EMSCRIPTEN_KEEPALIVE int join(void) { return DirectPlay_ConnectToSession(0, "Guest"); }
EMSCRIPTEN_KEEPALIVE int poll_host(void) { return DirectPlay_ConnectingToSession() == AVPMENU_MULTIPLAYERSTARTGAME; }
EMSCRIPTEN_KEEPALIVE int poll_guest(void) { return DirectPlay_ConnectingToSession() == AVPMENU_MULTIPLAYER_CONFIG_JOIN; }

EMSCRIPTEN_KEEPALIVE void frame(void)
{
    MinimalNetCollectMessages();
    NetSendMessages();
}

EMSCRIPTEN_KEEPALIVE int synced(int mode)
{
    int species = NGCT_Marine;
    if (mode == NGT_PredatorTag) species = NGCT_Predator;
    if (mode == NGT_AlienTag || mode == NGT_LastManStanding) species = NGCT_Alien;
    return netGameData.gameType == mode && netGameData.scoreLimit == 271 &&
           netGameData.preDestroyLights && !netGameData.allowFlamer &&
           !strcmp(netGameData.playerData[0].name, "Host") &&
           !strcmp(netGameData.playerData[1].name, "Guest") &&
           netGameData.playerData[0].characterType == species &&
           netGameData.playerData[0].characterSubType == (species == NGCT_Marine ? NGSCT_Smartgun : NGSCT_General);
}

EMSCRIPTEN_KEEPALIVE void choose(void)
{
    netGameData.myCharacterSubType = NGSCT_Pistols;
    AddNetMsg_PlayerDescription();
    NetSendMessages();
}

EMSCRIPTEN_KEEPALIVE int chosen(void)
{
    MinimalNetCollectMessages();
    return netGameData.playerData[1].characterSubType == NGSCT_Pistols;
}

EMSCRIPTEN_KEEPALIVE void send_scores(void)
{
    netGameData.teamScores[NGCT_Marine] = 57;
    AddNetMsg_SpeciesScores();
    NetSendMessages();
}

EMSCRIPTEN_KEEPALIVE int received_scores(void)
{
    netGameData.myGameState = NGS_Playing;
    MinimalNetCollectMessages();
    return netGameData.teamScores[NGCT_Marine] == 57;
}

EMSCRIPTEN_KEEPALIVE void leave(void) { DirectPlay_Disconnect(); }
