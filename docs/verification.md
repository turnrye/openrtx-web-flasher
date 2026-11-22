# Bench record

One line per flash that was checked on a real radio through this page, newest first.
See [qa.md](qa.md) for the procedure. A radio's `verified` entry in `src/radios.ts`
points at its latest line here.

| Date       | Radio                      | Firmware                                                                                     | Site commit  | Browser, OS       | Source                             | Result                                                                                               | By        |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------- | ------------ | ----------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- | --------- |
| 2026-11-21 | Connect Systems CS7000-M17 | CI build of the `release-v0.5.0` branch                                                      | not recorded | not recorded      | `release-v0.5.0` branch build      | Flashed, and the radio started OpenRTX. No backup was taken. Reported to the maintainer second hand. | Jim N1ADJ |
| 2026-11-21 | Retevis C62                | CI build of 20 Nov 2026: `zephyr.bin` (SHA-256 bbaa9c57…) and `dsp_firmware.bin` (9579b617…) | 577c8db      | Chrome 156, macOS | `openrtx-c62.zip`, given as a file | Backed up, flashed from the original firmware, and the radio started OpenRTX.                        | turnrye   |

Notes on the C62 line:

- The backup taken by the page before flashing was compared with a `cskburn` dump of the
  same radio; see the C62 section of [bench-notes.md](bench-notes.md).
- An earlier attempt the same day with site commit 5916987 wrote the application only
  and left the radio at a black screen. 577c8db writes the DSP image as well.
- Not covered: restoring a backup from the page (the radio was put back to its original
  firmware with `cskburn` between the two attempts), the C2, Windows and Linux.

Notes on the CS7000-M17 line:

- It rests on a report passed on by the maintainer, not on a run the maintainer watched.
  The site commit and the browser and system were not recorded. If Jim can supply them,
  fill them in here and in `src/radios.ts`.
- The backup step was not used, so reading this radio from the page is still unchecked.
- The key combination the page shows for this radio is still marked as unconfirmed: the
  report does not say how the radio was put in flashing mode.
