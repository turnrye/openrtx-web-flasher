# Bench record

One line per flash that was checked on a real radio through this page, newest first.
See [qa.md](qa.md) for the procedure. A radio's `verified` entry in `src/radios.ts`
points at its latest line here.

| Date       | Radio                           | Firmware                                                                                     | Site commit           | Browser, OS       | Source                             | Result                                                                                                                                                                | By        |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------------------- | --------------------- | ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 2026-11-25 | Tytera MD-9600                  | Local development build 242dcee0, `_wrap.bin` (SHA-256 dbdd5017…)                            | 1cf75e7, command line | Node 26.9, macOS  | file given                         | Flashed through the TYT bootloader without `sudo`, and the radio started that build (its Info screen showed it). No backup: the radio was already running OpenRTX.    | turnrye   |
| 2026-11-24 | Connect Systems CS7000-M17 Plus | Local development build 9951a7d1, `.dfu` (SHA-256 ce9533bc…)                                 | 12fc2f7, command line | Node 26.9, macOS  | file given                         | Flashed in robot mode through the Connect Systems bootloader (B7.06) with `sudo`, and the radio started OpenRTX with SK3. No backup: a stock radio is read-protected. | turnrye   |
| 2026-11-21 | Connect Systems CS7000-M17      | CI build of the `release-v0.5.0` branch                                                      | not recorded          | not recorded      | `release-v0.5.0` branch build      | Flashed, and the radio started OpenRTX. No backup was taken. Reported to the maintainer second hand.                                                                  | Jim N1ADJ |
| 2026-11-21 | Retevis C62                     | CI build of 20 Nov 2026: `zephyr.bin` (SHA-256 bbaa9c57…) and `dsp_firmware.bin` (9579b617…) | 577c8db               | Chrome 156, macOS | `openrtx-c62.zip`, given as a file | Backed up, flashed from the original firmware, and the radio started OpenRTX.                                                                                         | turnrye   |

Notes on the MD-9600 line:

- This is the command line, not the page. It is recorded in `commandLineVerified` in `src/radios.ts`.
  The page's `verified` stays empty for this radio.
- Build 1cf75e7 is the `fix/cs7000p-robot-mode` branch before it was squashed into
  52be644. The TYT flasher, the DFU layer and the USB code are the same in both.
- The radio is a V5 board (stock firmware S126.061), and it was running an earlier
  OpenRTX build, not its stock firmware. The bootloader showed up as 0483:df11 "Digital
  Radio in USB mode", and the screen blinked on and off in flashing mode.
- Not covered: flashing from the stock firmware, the backup step, Linux, and a release
  build. The MD-380, MD-UV380 and DM-1701 use the same flasher but stay unchecked.

Notes on the C62 line:

- The backup taken by the page before flashing was compared with a `cskburn` dump of the
  same radio; see the C62 section of [bench-notes.md](bench-notes.md).
- An earlier attempt the same day with site commit 5916987 wrote the application only
  and left the radio at a black screen. 577c8db writes the DSP image as well.
- Not covered: restoring a backup from the page (the radio was put back to its original
  firmware with `cskburn` between the two attempts), the C2, Windows and Linux.

Notes on the CS7000-M17 Plus line:

- This is the command line, not the page: the page cannot reach robot mode. It is
  recorded in `commandLineVerified` in `src/radios.ts`. The page's `verified` stays empty for this
  radio.
- The tool printed build 0b44884: it was built from 12fc2f7's files before they were
  committed.
- The radio had just been put back to its Connect Systems bootloader and DMR firmware.
  Not covered: Linux, and a release build.

Notes on the CS7000-M17 line:

- It rests on a report passed on by the maintainer, not on a run the maintainer watched.
  The site commit and the browser and system were not recorded. If Jim can supply them,
  fill them in here and in `src/radios.ts`.
- The backup step was not used, so reading this radio from the page is still unchecked.
- The key combination the page shows for this radio is still marked as unconfirmed: the
  report does not say how the radio was put in flashing mode.
