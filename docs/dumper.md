# Dumpers

A design note. Nothing here is built on `main` yet.

[backup-coverage.md](backup-coverage.md) lists what a backup does not hold. Some of those
gaps cannot be closed by asking the radio: its bootloader does not read, and its original
firmware gives only part of what it has. For those the record says "needs a dumper".

A dumper is a small firmware written for one job: it runs on the radio in place of the
usual firmware, reads every memory the radio has and sends it to the computer. It is
loaded for the occasion and replaced afterwards. It never writes to the memories it reads.

## What each radio needs

| Radio                                   | How the dumper gets in                                                         | What loading it costs                                                | What it must send                                                | Estimate                             |
| --------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| RT-950 Pro                              | In progress on a branch (`rt950pro-full-backup`)                               | The original firmware, which Radtel publishes                        | The whole 4 MiB memory chip                                      | In progress                          |
| DM-32UV                                 | In progress on a branch (`dm32uv`); the radio is not on `main`                 |                                                                      | The program memory and the memory chip                           | In progress                          |
| CS7000                                  | Over DFU, in place of the firmware                                             | Nothing: the page saves the program memory first and can put it back | The 16 MiB memory chip                                           | 1 to 2 weeks                         |
| CS7000 Plus                             | In robot mode, into the second firmware slot; command line only                | Whatever the second slot held                                        | The 32 MiB memory chip; the program memory if it can be read     | 3 to 4 weeks                         |
| MD-9600, then MD-UV380, MD-380, DM-1701 | Through TYT's bootloader, into the first 16 KB of the firmware area (sector 3) | Sector 3, which the read through the original firmware saves first   | The other 960 KB of program memory; the three security registers | 2 to 3 weeks, then about 1 per model |
| GD-77, DM-1801                          | Through the bootloader, as firmware                                            | The original firmware                                                | The 64 KiB EEPROM, the 1 MiB memory chip, the program memory     | About 2 weeks                        |

Not on the list:

- T-TWR Plus needs no dumper. The ESP32-S3's own download mode reads all 16 MB; the page
  could do that with esptool-js, about a week of work. Nothing is known here that reads
  the radio module (SA868S).
- RT-4D: the memory chip is read whole through the original firmware. A dumper would
  add the bootloader only, since it takes the firmware's place.

The TYT dumper starts from one the maintainer already has for sector 3 of the MD-9600,
made general and sending over USB serial. The GD-77 one would be built from OpenRTX's
drivers for those radios.

## Parts

- **A catalogue entry per radio**, next to the coverage record: how the dumper loads
  (into RAM, into one flash page, or over the firmware), what that costs, which regions
  it reads, and what carries the data.
- **One engine on the computer** for all of them, with the framing of the DM-32UV reader
  on its branch: 4 KB sectors, a CRC on each, and a second pass over the whole memory to
  check it.
- **One small firmware per radio.** It has no erase and no program command for the
  memories it reads, so no request from the computer can make it write them.

## Steps, on the page and the command line

1. **Read through the original firmware first**, as today, and save that backup. It is
   the record if anything later goes wrong, and on the TYT radios it holds what the
   dumper will overwrite.
2. **Say what the radio will run afterwards**: the dumper, not its firmware. Name what
   loading it overwrites, whether that was saved in step 1, and how the radio gets back.
   Ask before going on.
3. **Load** the dumper through the bootloader.
4. **Read** every region, sector by sector.
5. **Verify**: every sector's CRC, then the second pass. A read that fails either is
   saved as incomplete and says where it stopped.
6. **The way back**: flash OpenRTX, or the manufacturer's firmware, or the saved program
   memory where the page can write it. The page does not leave the radio on the dumper
   without saying so.

## Rules

- No dumper is loaded before step 1 has saved a backup that covers what the dumper
  overwrites. On Linux a TYT radio gives 4,096 bytes of program memory in step 1, not
  the 65,535 that cover sector 3, so the TYT dumper must refuse there.
- The dumper firmware cannot write the memories it reads.
- On the CS7000 and CS7000 Plus the dumper has to run before OpenRTX first starts:
  OpenRTX erases 16 KB of the memory chip for its settings on that first start.
- Every dumper stays behind the experimental gate until its way back has been proven on
  a real radio.
- A backup is never called whole unless every sector passed both checks.
- Simulators first, as for every flasher and reader here.

## Order

1. RT-950 Pro and DM-32UV: furthest along, each in progress on a branch.
2. CS7000, then CS7000 Plus: the worst gap. The calibration on the memory chip is not
   published, and OpenRTX writes to that chip.
3. MD-9600, then MD-UV390: the firmware and the calibration as stored. OpenRTX does not
   write the security registers, so they can still be saved later.
4. GD-77 and DM-1801.

## Not settled

- TYT: the snapshot in step 1 is 65,535 bytes, one short of the end of sector 3. That
  byte has to come from somewhere before sector 3 is erased.
- CS7000 Plus: whether code in the second slot can read a read-protected program
  memory, and what the second slot holds on a radio as shipped.
- GD-77, DM-1801: the reader's own notes mention a start-up mode of the original
  firmware that reads the whole memory chip. If it exists, it may close that part
  without a dumper.
- Each estimate is from the audit, without a radio on the bench.
