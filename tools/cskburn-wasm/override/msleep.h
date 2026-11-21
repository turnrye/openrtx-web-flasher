/** @file msleep.h  Web build: sleep by yielding to the JS event loop (Asyncify). */
#ifndef __LIB_PORTABLE_MSLEEP__
#define __LIB_PORTABLE_MSLEEP__
#include <emscripten.h>
#define msleep(ms) emscripten_sleep(ms)
#endif
