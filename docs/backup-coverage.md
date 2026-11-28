# Backup coverage

<!-- Written from src/coverage.ts. Do not edit: change the record, then run `npm run coverage-doc`. -->

What a backup made by this page, or by its command line, holds of each radio, memory by
memory, and what it does not. Every memory that is not saved whole is a critical gap: once
OpenRTX is on the radio, what was not saved may be gone for good. Where neither the
radio's bootloader nor its original firmware gives a memory up, the gap needs a dumper;
[dumper.md](dumper.md) says what that is.

Of the 13 radios, 2 are backed up whole: the Module 17 and Retevis C62 / C2.
The other 11 have at least one critical gap.

The hardware facts are from a backup-coverage audit of 2026-11-26 and from the sources each
reader names. "Not confirmed" marks what nobody has checked on a radio.

## Every memory

| Radio                           | Memory                               | Size           | Saved    | Run on a real radio    | To close the gap |
| ------------------------------- | ------------------------------------ | -------------- | -------- | ---------------------- | ---------------- |
| Tytera MD-380 / MD-390          | program memory (STM32F405)           | 1 MiB          | **part** | no                     | needs a dumper   |
| Tytera MD-380 / MD-390          | memory chip (W25Q128)                | 16 MiB         | all      | no                     | nothing to close |
| Tytera MD-380 / MD-390          | the memory chip's security registers | 768 bytes      | **none** | nothing is read        | needs a dumper   |
| Tytera MD-UV380 / MD-UV390      | program memory (STM32F405)           | 1 MiB          | **part** | no                     | needs a dumper   |
| Tytera MD-UV380 / MD-UV390      | memory chip (W25Q128)                | 16 MiB         | all      | no                     | nothing to close |
| Tytera MD-UV380 / MD-UV390      | the memory chip's security registers | 768 bytes      | **none** | nothing is read        | needs a dumper   |
| Tytera MD-9600                  | program memory (STM32F405)           | 1 MiB          | **part** | with another tool only | needs a dumper   |
| Tytera MD-9600                  | memory chip (W25Q128)                | 16 MiB         | all      | with another tool only | nothing to close |
| Tytera MD-9600                  | the memory chip's security registers | 768 bytes      | **none** | nothing is read        | needs a dumper   |
| Baofeng DM-1701                 | program memory (STM32F405)           | 1 MiB          | **part** | no                     | needs a dumper   |
| Baofeng DM-1701                 | memory chip (W25Q128)                | 16 MiB         | all      | no                     | nothing to close |
| Baofeng DM-1701                 | the memory chip's security registers | 768 bytes      | **none** | nothing is read        | needs a dumper   |
| Radioddity GD-77                | program memory (MK22FN512)           | 512 KiB        | **none** | nothing is read        | needs a dumper   |
| Radioddity GD-77                | EEPROM                               | 64 KiB         | **part** | no                     | needs a dumper   |
| Radioddity GD-77                | memory chip                          | 1 MiB          | **part** | no                     | needs a dumper   |
| Baofeng DM-1801                 | program memory (MK22FN512)           | 512 KiB        | **none** | nothing is read        | needs a dumper   |
| Baofeng DM-1801                 | EEPROM                               | 64 KiB         | **part** | no                     | needs a dumper   |
| Baofeng DM-1801                 | memory chip                          | 1 MiB          | **part** | no                     | needs a dumper   |
| Connect Systems CS7000-M17      | program memory (STM32F405)           | 1 MiB          | all      | no                     | nothing to close |
| Connect Systems CS7000-M17      | memory chip (W25Q128)                | 16 MiB         | **none** | nothing is read        | needs a dumper   |
| Connect Systems CS7000-M17 Plus | program memory (STM32H743)           | 2 MiB          | **part** | no                     | needs a dumper   |
| Connect Systems CS7000-M17 Plus | memory chip                          | 32 MiB         | **none** | nothing is read        | needs a dumper   |
| Radtel RT-4D                    | program memory (AT32F423)            | 256 KiB        | **none** | nothing is read        | needs a dumper   |
| Radtel RT-4D                    | memory chip                          | 16 MiB         | all      | no                     | nothing to close |
| Radtel RT-950 Pro               | program memory                       | 1 MiB          | **none** | nothing is read        | needs a dumper   |
| Radtel RT-950 Pro               | memory chip                          | 4 MiB          | **part** | no                     | needs a dumper   |
| Module 17                       | program memory (STM32F405)           | 1 MiB          | all      | no                     | nothing to close |
| Lilygo T-TWR Plus               | flash of the ESP32-S3                | 16 MiB         | **part** | no                     | esptool reads it |
| Lilygo T-TWR Plus               | the radio module (SA868S)            | size not known | **none** | nothing is read        | needs a dumper   |
| Retevis C62 / C2                | flash of the CSK6 module             | 4 MiB          | all      | yes                    | nothing to close |

"Run on a real radio" is about this tool's own read. [bench-notes.md](bench-notes.md) and
[verification.md](verification.md) have the record.

## Critical gaps, worst first

Ordered by what is lost for good and how soon flashing loses it.

### 1. Connect Systems CS7000-M17

- **Memory chip (W25Q128)** (16 MiB), not saved. It holds the factory calibration (OpenRTX reads it at 0x1000 to 0x10DC), other data from the maker, and the original firmware's channels and settings.
  - Saved: Nothing: flashing mode reaches the program memory only.
  - Lost without it: The factory calibration, which is not published. OpenRTX erases 0x8000 to 0xBFFF of this chip for its own settings the first time it starts.
  - To close it, a dumper: A reader loaded over DFU in place of the firmware, once the program memory is saved, that sends the 16 MiB chip over USB. It must run before OpenRTX first starts.
  - Limits of that dumper: What OpenRTX erased (0x8000 to 0xBFFF) on a radio that has already run it.

### 2. Connect Systems CS7000-M17 Plus

- **Program memory (STM32H743)** (2 MiB), saved in part. It holds the Connect Systems bootloader and both firmware slots.
  - Saved: All 2 MiB in DFU mode, but only from a radio that lets itself be read. A radio with its Connect Systems firmware read-protects the chip and gives nothing, and robot mode (the command line) cannot read at all.
  - Lost without it: The bootloader and DMR firmware as this radio had them. Flashing OpenRTX leaves both in place, and Connect Systems publishes both.
  - To close it, a dumper: A reader written to the second firmware slot in robot mode, from the command line only, that sends the memory chip and the program memory over USB.
  - Limits of that dumper: Whatever the second slot held before.
  - Not confirmed: Whether code in the second slot can read the protected program memory.
- **Memory chip** (32 MiB), not saved. It holds the factory calibration (OpenRTX reads it at 0x1000 to 0x10DC), other data from the maker, and the original firmware's channels and settings.
  - Saved: Nothing: neither flashing mode reaches it.
  - Lost without it: The factory calibration, which is not published. OpenRTX erases 0x1000000 to 0x1003FFF of this chip for its own settings the first time it starts.
  - To close it, a dumper: The same reader in the second firmware slot: it sends all 32 MiB over USB. It must run before OpenRTX first starts.
  - Limits of that dumper: What OpenRTX erased (0x1000000 to 0x1003FFF) on a radio that has already run it.

### 3. Radtel RT-950 Pro

- **Program memory** (1 MiB), not saved. It holds Radtel's bootloader (the first 12 KiB, which flashing never writes) and the original firmware.
  - Saved: Nothing: the bootloader cannot be read.
  - Lost without it: The original firmware as this radio had it. Flashing replaces it; Radtel publishes firmware files.
  - To close it, a dumper: A reader firmware for this radio. In progress on a branch (rt950pro-full-backup).
  - Limits of that dumper: The original firmware, where the reader takes its place. That comes back with Radtel’s file.
- **Memory chip** (4 MiB), saved in part. It holds channels, settings and the calibration areas in the first 64 KiB; fonts, the start-up picture and the rest above.
  - Saved: The first 64 KiB, which is as far as the programming protocol’s 16-bit address reaches.
  - Lost without it: Everything above 64 KiB, which is 63/64 of the chip: fonts, the start-up picture and whatever else Radtel keeps there.
  - To close it, a dumper: The same reader firmware sends the whole 4 MiB. In progress on a branch (rt950pro-full-backup).

### 4. Tytera MD-9600, Tytera MD-UV380 / MD-UV390, Tytera MD-380 / MD-390 and Baofeng DM-1701

- **Program memory (STM32F405)** (1 MiB), saved in part. It holds TYT's bootloader (the first 48 KB) and the original firmware.
  - Saved: The first 65,535 bytes: the bootloader and the first 16 KB of the firmware. On Linux 4,096 bytes, because the system caps the request.
  - Lost without it: The original firmware as this radio had it (the other 960 KB). Flashing replaces it, and the only way back is the manufacturer's firmware file for this model and board.
  - To close it, a dumper: Run from the first 16 KB of the firmware area (flash sector 3), which the read through the original firmware saves first, and send the rest of the program memory and the three security registers over USB.
  - Limits of that dumper: On Linux the first read saves 4,096 bytes, not the 65,535 that cover sector 3, so the dumper must not be loaded from Linux. The snapshot also ends one byte before the end of sector 3.
- **The memory chip's security registers** (768 bytes), not saved. It holds the factory calibration as stored (512 bytes in registers 1 and 2) and the hardware option block (64 bytes in register 3).
  - Saved: Nothing of the registers themselves. The backup has what the firmware reports in their place: the calibration as loaded in RAM (info block 05) and the option block (info blocks 01 and 03).
  - Lost without it: The factory calibration in the form it is stored, which is not published. OpenRTX reads its calibration from these registers and does not write them.
  - To close it: the same as the one above.

### 5. Radioddity GD-77

- **Program memory (MK22FN512)** (512 KiB), not saved. It holds the bootloader and the original firmware.
  - Saved: Nothing: neither the bootloader nor the programming protocol reads it.
  - Lost without it: The original firmware as this radio had it. Flashing replaces it, and the only way back is the manufacturer's firmware file.
  - To close it, a dumper: A reader built from OpenRTX's drivers for these radios, loaded like firmware through the bootloader, that sends the whole EEPROM, the whole memory chip and the program memory over USB.
  - Limits of that dumper: The original firmware: the bootloader puts the dumper in its place. That comes back with the manufacturer’s firmware file.
- **EEPROM** (64 KiB), saved in part. It holds channels, zones and settings.
  - Saved: 64,384 of 65,536 bytes: programming addresses 0x0080 to 0x7BFF and 0x8000 to 0xFFFF.
  - Lost without it: The first 128 bytes and 0x7C00 to 0x7FFF. What they hold is not known here.
  - To close it: the same as the one above.
- **Memory chip** (1 MiB), saved in part. It holds the upper part of the codeplug, and the factory calibration (OpenRTX reads it at 0x8F000).
  - Saved: 61,088 bytes: programming addresses 0x10000 to 0x1EE9F. Also the 4 KB the firmware returns at 0x7C00, which holds the calibration on the firmware versions that answer there.
  - Lost without it: The rest of the chip, and with it the factory calibration, which is not published, on a radio whose firmware does not give it at 0x7C00. The backup says when it did not.
  - To close it: the same as the one above.
  - Not confirmed: Where the programming addresses land on the chip.

### 6. Baofeng DM-1801

- **Program memory (MK22FN512)** (512 KiB), not saved. It holds the bootloader and the original firmware.
  - Saved: Nothing: neither the bootloader nor the programming protocol reads it.
  - Lost without it: The original firmware as this radio had it. Flashing replaces it, and the only way back is the manufacturer's firmware file.
  - To close it, a dumper: A reader built from OpenRTX's drivers for these radios, loaded like firmware through the bootloader, that sends the whole EEPROM, the whole memory chip and the program memory over USB.
  - Limits of that dumper: The original firmware: the bootloader puts the dumper in its place. That comes back with the manufacturer’s firmware file.
- **EEPROM** (64 KiB), saved in part. It holds channels, zones and settings.
  - Saved: 64,384 of 65,536 bytes: programming addresses 0x0080 to 0x7BFF and 0x8000 to 0xFFFF.
  - Lost without it: The first 128 bytes and 0x7C00 to 0x7FFF. What they hold is not known here.
  - To close it: the same as the one above.
- **Memory chip** (1 MiB), saved in part. It holds the upper part of the codeplug, and the factory calibration (OpenRTX reads it at 0x6F000).
  - Saved: 61,056 bytes: programming addresses 0x10000 to 0x1EE7F. Also the 4 KB the firmware returns at 0x7C00, which holds the calibration on the firmware versions that answer there.
  - Lost without it: The rest of the chip, and with it the factory calibration, which is not published, on a radio whose firmware does not give it at 0x7C00. The backup says when it did not.
  - To close it: the same as the one above.
  - Not confirmed: Where the programming addresses land on the chip.

### 7. Lilygo T-TWR Plus

- **Flash of the ESP32-S3** (16 MiB), saved in part. It holds the bootloader, the settings area (NVS), the firmware and an 11.7 MB storage area.
  - Saved: The firmware only, and only if you copy CURRENT.UF2 off the drive yourself: the tool reads nothing.
  - Lost without it: The bootloader, the settings area and the storage area as the radio came.
  - To close it: [esptool](https://github.com/espressif/esptool). In the ESP32-S3’s ROM download mode, esptool reads all 16 MB: `esptool.py read_flash 0 0x1000000 backup.bin`. The page could do the same with esptool-js; that is not built.
- **The radio module (SA868S)** (size not known), not saved. It holds the module's own firmware, which the open sa8x8 firmware replaces before OpenRTX can be used.
  - Saved: Nothing.
  - Lost without it: The module's original firmware.
  - To close it, a dumper: Not worked out: no way to read the module is known here.
  - Not confirmed: How much memory the module has, and whether it can be read at all.

### 8. Radtel RT-4D

- **Program memory (AT32F423)** (256 KiB), not saved. It holds the bootloader and the original firmware.
  - Saved: Nothing: neither the bootloader nor the programming protocol reads it.
  - Lost without it: The original firmware as this radio had it. Flashing replaces it, and the only way back is the manufacturer's firmware file.
  - To close it, a dumper: A reader loaded like firmware through the bootloader that sends the program memory over the programming cable.
  - Limits of that dumper: The original firmware: the bootloader puts the dumper in its place. Only the bootloader would be gained.

## What is saved whole

- **Tytera MD-380 / MD-390**, memory chip (W25Q128) (16 MiB): all 16 MiB. It holds channels, contacts and settings, and the fonts and other resources of the original firmware. Not confirmed: What the original firmware answers was measured on an MD-9600 only; this model is assumed to answer the same. Some early VHF MD-380s have a 1 MB memory chip, and what the read does past its end is not known.
- **Tytera MD-UV380 / MD-UV390**, memory chip (W25Q128) (16 MiB): all 16 MiB. It holds channels, contacts and settings, and the fonts and other resources of the original firmware. Not confirmed: What the original firmware answers was measured on an MD-9600 only; this model is assumed to answer the same.
- **Tytera MD-9600**, memory chip (W25Q128) (16 MiB): all 16 MiB. It holds channels, contacts and settings, and the fonts and other resources of the original firmware. Not confirmed: What the original firmware answers was measured on MD-9600s with other tools (RadioFoundry, and the maintainer’s own). This tool’s read has not been run on a radio.
- **Baofeng DM-1701**, memory chip (W25Q128) (16 MiB): all 16 MiB. It holds channels, contacts and settings, and the fonts and other resources of the original firmware. Not confirmed: What the original firmware answers was measured on an MD-9600 only; this model is assumed to answer the same.
- **Connect Systems CS7000-M17**, program memory (STM32F405) (1 MiB): all 1 MiB, in flashing mode; the page can write it back. It holds the bootloader and the original firmware.
- **Radtel RT-4D**, memory chip (16 MiB): all 16 MiB, one 1,024-byte block at a time. It holds calibration, settings, channels, zones, contacts, the boot logo, fonts and voices in the first 4 MiB; the address book above it. Not confirmed: The tool this read follows stops at 4 MiB. That the original firmware also answers for the blocks above is taken from the block numbering and from open firmware for a sibling radio, not from an RT-4D. A read that stops there keeps the first 4 MiB and is marked incomplete.
- **Module 17**, program memory (STM32F405) (1 MiB): all 1 MiB, in flashing mode; the page can write it back. It holds the firmware, and settings and calibration in the last sector.
- **Retevis C62 / C2**, flash of the CSK6 module (4 MiB): all 4 MiB, checked against an MD5 the chip computes; the page can write it back. It holds firmware, DSP image, calibration, channels and settings. Not confirmed: Writing a backup back from the page has not been tried on a radio.

## Radios that already run OpenRTX

A radio that already runs OpenRTX cannot be backed up this way: the read is answered by the manufacturer's firmware, and OpenRTX has replaced it. OpenRTX has no backup command of its own yet.

This goes for the Tytera MD-380 / MD-390, Tytera MD-UV380 / MD-UV390, Tytera MD-9600, Baofeng DM-1701, Radioddity GD-77, Baofeng DM-1801, Radtel RT-4D and Radtel RT-950 Pro.

The others are read without the help of the firmware they run. On a radio that runs
OpenRTX such a read gives OpenRTX and its settings, not what the radio came with.

OpenRTX has a routine that sends the memory chip over XMODEM (`openrtx/src/core/backup.c`),
but nothing in the firmware calls it.
