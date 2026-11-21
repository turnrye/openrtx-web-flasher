// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @file serial_web.c
 * libserial backend for the browser: forwards every call to Module.cskSerial
 * (Web Serial in Chrome, or a mock in Node). Blocking C calls become awaits via Asyncify.
 */
#include <emscripten.h>
#include <errno.h>
#include <stdlib.h>

#include "serial.h"

struct _serial_dev_t {
	int unused;
};

EM_ASYNC_JS(int, js_open, (const char *path), {
	return await Module.cskSerial.open(UTF8ToString(path));
});
EM_ASYNC_JS(void, js_close, (void), { await Module.cskSerial.close(); });
EM_ASYNC_JS(int, js_set_baud, (uint32_t baud), { return await Module.cskSerial.setBaud(baud); });
EM_ASYNC_JS(int, js_read, (uint8_t * buf, int count, double timeout), {
	const d = await Module.cskSerial.read(count, timeout);
	if (!d || d.length == 0) return 0;
	HEAPU8.set(d, buf);
	return d.length;
});
EM_ASYNC_JS(int, js_write, (const uint8_t *buf, int count), {
	await Module.cskSerial.write(HEAPU8.slice(buf, buf + count));
	return count;
});
EM_JS(void, js_discard_input, (void), { Module.cskSerial.discardInput(); });
EM_ASYNC_JS(int, js_set_signal, (int dtr, int active), {
	return await Module.cskSerial.setSignal(dtr ? "dataTerminalReady" : "requestToSend", !!active);
});

/** Opens the port the page already picked; path is informational. */
int
serial_open(const char *path, serial_dev_t **dev)
{
	int ret = js_open(path);
	if (ret != 0) {
		return ret;
	}
	*dev = calloc(1, sizeof(serial_dev_t));
	return *dev == NULL ? -ENOMEM : 0;
}

/** Closes the port and frees the handle. */
void
serial_close(serial_dev_t **dev)
{
	js_close();
	free(*dev);
	*dev = NULL;
}

/** Web Serial cannot change baud live; the JS side reopens the port. */
int
serial_set_speed(serial_dev_t *dev, uint32_t speed)
{
	return js_set_baud(speed);
}

/** Returns >0 bytes, or -ETIMEDOUT when nothing arrives within timeout ms. */
ssize_t
serial_read(serial_dev_t *dev, void *buf, size_t count, uint64_t timeout)
{
	int n = js_read(buf, (int)count, (double)timeout);
	return n > 0 ? n : -ETIMEDOUT;
}

/** Writes all of buf; Web Serial has no write timeout. */
ssize_t
serial_write(serial_dev_t *dev, const void *buf, size_t count, uint64_t timeout)
{
	return js_write(buf, (int)count);
}

/** Drops buffered RX bytes. */
void
serial_discard_input(serial_dev_t *dev)
{
	js_discard_input();
}

/** No-op: writes are awaited, so nothing is queued. */
void
serial_discard_output(serial_dev_t *dev)
{
}

/** Asserts (true) or clears RTS. */
int
serial_set_rts(serial_dev_t *dev, bool active)
{
	return js_set_signal(0, active);
}

/** Asserts (true) or clears DTR. */
int
serial_set_dtr(serial_dev_t *dev, bool active)
{
	return js_set_signal(1, active);
}
