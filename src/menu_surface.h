#ifndef AVP_MENU_SURFACE_H
#define AVP_MENU_SURFACE_H
#include "SDL.h"

/* The built-in browser backend writes RGB565 directly into engine-owned RAM. */
#ifdef AVP_WEB_BUILTIN_SDL
#define AVP_MENU_MUSTLOCK(surface) 0
#else
#define AVP_MENU_MUSTLOCK(surface) SDL_MUSTLOCK(surface)
#endif
#endif
