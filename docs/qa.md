# How we know flashing works

A bad flasher can leave someone's radio without firmware, so nothing is offered by
default until it has been checked on the real radio. Four layers, cheapest first.

Before any of them, every commit has to pass the static checks in `npm run check`:
Prettier, ESLint with type-aware rules (a promise nobody waits for is an error, which
matters in code that talks to a bootloader), stylelint, shellcheck and the TypeScript
compiler. `ci/build.sh` runs them on both forges and stops at the first failure.

## 1. Protocol tests (every commit)

`npm test`. Each flasher runs against a simulated radio in `src/sim/` that speaks the
bootloader's protocol, keeps a flash image and is strict: wrong order, wrong address,
write before erase, bad checksum or early poll and the simulator stops answering, so the
flasher fails. The tests then compare the simulator's flash with the input byte for byte.

Two things keep the simulators honest:

- They are written from the reference tools (radio_tool, gd-77_firmware_loader.py,
  RT-4D-python-flasher, cskburn), and the C62 one runs the real cskburn.
- Set `ORTX_RELEASE_DIR` to a folder with OpenRTX release files and the tests also parse
  and flash those. The TYT parser was checked against `radio_tool --fw-info`.

What this layer cannot show: that the real bootloader behaves like the reference tool
says. That is layer 3.

## 2. Browser tests (every commit, both forges)

`npm run build && npm run e2e`. Playwright drives real Chromium through the built site,
served from a sub-folder as on a Pages host. For every radio it picks the radio, picks
the master build and a release, walks the steps, turns on experimental flashing,
flashes, and asks the simulated radio whether it holds exactly the file the page
offered. The same question
with one byte changed must fail, so the check cannot pass by accident.

Also covered: backing up every readable radio and comparing the zip with what the
simulator holds, restoring, the folding steps, the experimental confirmation, browsers
without WebUSB, pull request builds (GitHub API mocked), radios that do not answer or
are in the wrong mode, wrong file for the radio.

The firmware is the real build mirrored from GitHub, so a release whose files this page
cannot parse fails CI the night it appears.

The same tests run against a published copy, to check a deployment or a preview:

    E2E_BASE_URL=https://<owner>.github.io/<repo>/pr-preview/pr-1/ npm run e2e

## 3. Bench check on real hardware (per radio, per release of this site)

The only layer that proves anything about a real radio. For each radio on the bench:

1. Back up the radio with the page's "Back up now", and the codeplug with the usual
   programming software as well. The first time, check the page's backup against the
   usual tool: for the C62, Module 17, CS7000 and CS7000 Plus the image inside the zip
   must be identical to a `cskburn --read` or `dfu-util -U` dump; for the radios read
   through their original firmware, see the comparisons in
   [bench-notes.md](bench-notes.md).
2. Open the published site in Chrome, turn on experimental flashing, flash the latest
   OpenRTX release.
3. Pass when: the page reports done, the radio boots OpenRTX, and the version on the
   radio's info screen matches. Where the bootloader can read back (STM32 DFU, C62) the
   page has already compared the flash; note it.
4. Flash once more from each firmware source the release changed (branch build, local
   file).
5. Unplug mid-write once and confirm the radio can be flashed again.
6. Where the page can restore (C62, Module 17, CS7000, CS7000 Plus), flash the backup
   from step 1 back and confirm the radio is as it was.
7. Record it: add `verified` for the radio in `src/radios.ts` (version, browser and OS,
   date) and a line in `docs/verification.md` with who and how. That turns the
   experimental gate off for that radio and shows "checked on a real radio" in the page.

Repeat on Windows for one WebUSB radio (needs the WinUSB driver via Zadig) and on Linux
for the GD-77 (needs a hidraw udev rule); those are the two known platform traps.

Per-protocol things to watch on the first bench run are in
[bench-notes.md](bench-notes.md).

This can be semi-automated: Playwright can drive a real Chrome up to the device chooser,
the operator picks the radio and confirms it booted. That fits the Robot Framework bench
suites in OpenRTX-Acceptance-Testing (operator prompts, results published per firmware
and radio). Not built yet.

## 4. After release

- The page shows per radio whether it was checked, on what and when.
- A change to a flasher or its simulator clears `verified` for the radios that use it
  until the bench check is repeated. Reviewers enforce this; a CI check comparing the
  touched files with the `verified` entries is a good next step.
- A failed flash or backup in the field comes back through "Report this": an issue
  titled "Failed: <radio>, <step>" with the message and the end of the log.
- A flash that worked on a radio nobody has checked comes back as "Worked: <radio> with
  <firmware>". A maintainer reads it, asks for what is missing (did the radio boot, does
  the version on its info screen match), and if it holds up records it: a line in
  `docs/verification.md` and the radio's `verified` entry, in a pull request that links
  the report. Nothing marks a radio as checked automatically. From then on the page
  stops asking for successes on that radio.

## The command line

`cli/` runs the same flashers and readers from Node, so layer 1 covers their protocols.
Its own tests (`cli/*.test.ts`, part of `npm test`) run whole commands against the
simulators, put its USB, serial and HID layers between the flashers and the simulators,
and run the bundle that npx runs as a process of its own.

Layer 3 has not been run with it for any radio. It reaches a radio through other
libraries than Chrome does, and the C62 through LISTENAI's release of cskburn instead of
the WebAssembly build, so a radio checked with the page is not checked with the command
line. Until it is, the command line asks for `--experimental`. A bench check made with
it is recorded in `CHECKED` in `cli/main.ts`, next to the line in `docs/verification.md`.

## Current state

| Radio                                   | Layers 1–2 | Bench                                                               |
| --------------------------------------- | ---------- | ------------------------------------------------------------------- |
| Retevis C62                             | passing    | backup and flash checked, 2026-11-21; no restore                    |
| Connect Systems CS7000-M17              | passing    | flash reported working, 2026-11-21; no backup; browser not recorded |
| Connect Systems CS7000-M17 Plus         | passing    | command line, robot mode: flash checked, 2026-11-24; page not run   |
| all TYT, GD-77 family, STM32 DFU, RT-4D | passing    | not yet run                                                         |
| Radtel RT-950 Pro                       | passing    | not yet run                                                         |

Radios on hand for the bench: MD-UV390, CS7000-M17 Plus, C62, MD-9600. GD-77, DM-1801,
Module 17, RT-4D, MD-380, DM-1701 and CS7000-M17 need a volunteer with the radio.
