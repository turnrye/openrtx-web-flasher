// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Whose work the flasher is built on: what it was ported from and what the site ships as
 * it is. The site's licences page lists these with the licence texts; they are the
 * notice the MIT, BSD, Apache and font licences ask to travel with a copy.
 */

/** One piece of other people's work. */
export interface Credit {
  name: string;
  url: string;
  /** Who wrote it, as they name themselves. */
  by: string;
  licence: string;
  /** What it is used for here. */
  use: string;
}

/** Code this site's own script was ported from or follows. */
export const PORTED: Credit[] = [
  {
    name: 'radio_tool',
    url: 'https://github.com/v0l/radio_tool',
    by: 'Copyright (c) 2020 v0l',
    licence: 'GPL-3.0-or-later',
    use: 'The TYT flasher is a port of it.',
  },
  {
    name: 'GD-77 firmware uploader',
    url: 'https://github.com/OpenRTX/OpenRTX/blob/master/scripts/gd-77_firmware_loader.py',
    by: 'Copyright Roger Clark VK3KYY and the OpenGD77 contributors',
    licence: 'GPL-2.0-or-later, used here under version 3 or later',
    use: 'The GD-77 and DM-1801 flasher is a port of it, as carried in OpenRTX.',
  },
  {
    name: 'RT-4D-python-flasher',
    url: 'https://github.com/fagci/RT-4D-python-flasher',
    by: 'Mikhail Yudin (fagci)',
    licence: 'GPL-3.0',
    use: 'The RT-4D flasher is a port of it.',
  },
  {
    name: 'OpenRTX RT-950 Pro port',
    url: 'https://github.com/Marko13-dev/OpenRTX/tree/rt950pro',
    by: 'Marko13 and the OpenRTX contributors',
    licence: 'GPL-3.0-or-later',
    use: 'The RT-950 Pro flasher follows the bootloader protocol in its rt950_flash.py.',
  },
  {
    name: 'Radtel-RT950-Pro-Firmware',
    url: 'https://github.com/Hertzz58/Radtel-RT950-Pro-Firmware',
    by: 'Hertzz58 and contributors',
    licence: 'GPL-3.0',
    use: 'The RT-950 Pro backup is a port of the read path of its cps_flash.py.',
  },
  {
    name: 'RadioFoundry',
    url: 'https://github.com/RadioFoundry/RadioFoundry',
    by: 'Copyright (c) 2026 The RadioFoundry Authors',
    licence: 'MIT',
    use: 'The TYT backup through the original firmware is a port of it.',
  },
  {
    name: 'dmrconfig',
    url: 'https://github.com/sergev/dmrconfig',
    by: 'Copyright (C) 2018-2019 Serge Vakulenko KK6ABQ',
    licence: 'BSD-3-Clause',
    use: 'Codeplug ranges, and the GD-77 and DM-1801 programming protocol.',
  },
  {
    name: 'cs7000plus_flasher',
    url: 'https://github.com/imostlylurk/cs7000plus_flasher',
    by: 'imostlylurk',
    licence: 'Apache-2.0',
    use: 'The CS7000-M17 Plus robot-mode protocol and its table, for the command line.',
  },
  {
    name: 'qdmr',
    url: 'https://github.com/hmatuschek/qdmr',
    by: 'Hannes Matuschek DM3MAT',
    licence: 'GPL-3.0-or-later',
    use: 'Codeplug ranges, and the GD-77 and DM-1801 programming protocol.',
  },
  {
    name: 'rt-4d-spiflash-cli',
    url: 'https://github.com/DualTachyon/rt-4d-spiflash-cli',
    by: 'DualTachyon',
    licence: 'Apache-2.0',
    use: 'The read command of the RT-4D backup.',
  },
  {
    name: 'webdfu',
    url: 'https://github.com/devanlai/webdfu',
    by: 'Devan Lai',
    licence: 'ISC',
    use: 'Two ideas in the USB DFU code; no code is taken from it.',
  },
];

/** Other people's work the site ships as it is. */
export const SHIPPED: Credit[] = [
  {
    name: 'cskburn',
    url: 'https://github.com/LISTENAI/cskburn',
    by: 'LISTENAI',
    licence: 'Apache-2.0',
    use: 'Flashes the Retevis C62. Compiled to WebAssembly unchanged, with its burner images.',
  },
  {
    name: 'Emscripten',
    url: 'https://github.com/emscripten-core/emscripten',
    by: 'Copyright (c) 2010-2014 Emscripten authors',
    licence: 'MIT',
    use: 'Its runtime is part of the compiled cskburn, with musl libc (MIT, Rich Felker and others).',
  },
  {
    name: 'Preact',
    url: 'https://preactjs.com',
    by: 'Copyright (c) 2015-present Jason Miller',
    licence: 'MIT',
    use: 'Draws the page.',
  },
  {
    name: 'fflate',
    url: 'https://github.com/101arrowz/fflate',
    by: 'Copyright (c) Arjun Barrett',
    licence: 'MIT',
    use: 'Reads and writes zip files.',
  },
  {
    name: 'Ubuntu font',
    url: 'https://design.ubuntu.com/font',
    by: 'Copyright Canonical Ltd.',
    licence: 'Ubuntu Font Licence 1.0',
    use: 'The typefaces Ubuntu and Ubuntu Mono, as packaged by Fontsource.',
  },
  {
    name: 'VT323',
    url: 'https://github.com/phoikoi/VT323',
    by: 'Copyright 2011, The VT323 Project Authors (Peter Hull)',
    licence: 'SIL Open Font License 1.1',
    use: 'The figures in the style of a radio display, as packaged by Fontsource.',
  },
  {
    name: 'openrtx-device-mockups',
    url: 'https://github.com/ranguli/openrtx-device-mockups',
    by: 'Joshua Murphy (ranguli, VO1RFX)',
    licence: 'GPL-3.0',
    use: 'The CS7000 and MD-380 drawings are his; the other radios are drawn in his style.',
  },
  {
    name: 'OpenRTX logo',
    url: 'https://openrtx.org',
    by: 'The OpenRTX project',
    licence: 'From the OpenRTX website',
    use: 'The page icon and header.',
  },
];
