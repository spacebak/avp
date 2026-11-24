/* The web engine uses the static menu background when no movie decoder is present. */
#include "fixer.h"
#include "bink.h"
BOOL BinkSys_Init(void) { return 0; }
void BinkSys_Release(void) {}
void PlayBinkedFMV(char *filenamePtr, int volume) {}
void StartMenuBackgroundBink(void) {}
int PlayMenuBackgroundBink(void) { return 0; }
void EndMenuBackgroundBink(void) {}
int StartMusicBink(char *filenamePtr, BOOL looping) { return 0; }
int PlayMusicBink(int volume) { return 0; }
void EndMusicBink(void) {}
FMVHandle CreateBinkFMV(char *filenamePtr) { return 0; }
int UpdateBinkFMV(FMVHandle handle, int volume) { return 0; }
void CloseBinkFMV(FMVHandle handle) {}
char *GetBinkFMVImage(FMVHandle handle) { return 0; }
