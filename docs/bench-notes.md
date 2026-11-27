# What to watch on the first bench run

Each flasher was written from a reference tool and tested against a simulator. These are
the points where the real radio could differ. The "Details" box on the page logs enough
to tell which one it was.

## Backups

- Most backups do not hold everything on the radio. [backup-coverage.md](backup-coverage.md)
  lists every memory of every radio, what is saved of it and what is not; only the C62
  and Module 17 are saved whole.
- A backup is only as good as its first restore. Until one has been restored on a real
  radio of that kind, treat the page's backup as unproven and keep a dump made with the
  usual tool as well.
- C62: the whole 4 MiB is read 64 bytes at a time, about ten minutes at 115200 baud.
  cskburn compares the result with an MD5 the chip computes. It reports a mismatch but
  still exits with code 0, so the page looks for its error lines too. Dumps are per
  radio (serial number and calibration live in the flash): never restore one onto
  another radio. The chip ID is read in the same run and is the backup's radio ID.
- STM32 DFU: a read-protected chip refuses the read and the page says so. Nothing is
  changed by trying. The radio ID is the bootloader's USB serial number. Check on the
  first two radios of a model that it differs between them; if it does not, the ID in
  the backup's name and in the Backups list does not tell them apart.
- CS7000 Plus: the backup is all 2 MiB, bootloader and both firmware slots. Restoring it
  rewrites the bootloader too.
- CS7000 and CS7000 Plus: the memory chip beside the processor (16 MiB and 32 MiB) is
  not in the backup. OpenRTX reads the factory calibration from 0x1000 to 0x10DC of it,
  and the first time it starts it erases an area for its own settings: 0x8000 to 0xBFFF
  on the CS7000, 0x1000000 to 0x1003FFF on the Plus. Restoring the backup does not put
  that back.

### Through the original firmware (TYT, GD-77, DM-1801, RT-4D, RT-950 Pro)

None of these reads has been run from the page on a radio. Each reader sends only read
requests and its simulator fails the test on anything else, but what a real radio
answers is known from other tools, and for the TYT family from one MD-9600.

- The page cannot write these backups back. They are a record of what each read
  reaches, which is never the whole radio: the program memory is missing from all of
  them, or all but its first 64 KB. Compare the first one of each model with a read made
  by the usual programming software.
- A radio that already runs OpenRTX gives nothing this way: the firmware that answered
  is gone.
- TYT: info blocks, one snapshot of the first 64 KB of internal flash (the bootloader),
  then the SPI flash in program mode, then `91 05`, on which the radio restarts.
  - Not read: the firmware beyond the snapshot (960 KB) and the memory chip's security
    registers, where the calibration is stored. Info block 05 is the firmware's copy of
    the calibration as loaded in RAM, not the stored bytes.
  - On an MD-9600 compare with a backup made by a known-good tool: the info blocks must
    be identical except `info-08` (the clock), the snapshot is 65535 bytes on macOS and
    Windows and 4096 on Linux (usbfs caps a control transfer), firmware reads
    "S126.061" style, and the radio restarts by itself.
  - Record how long 16 MB takes: one source says about a minute, another about six.
  - MD-380, MD-UV380 and DM-1701 are assumed to answer like the MD-9600. Early VHF
    MD-380s have a 1 MB memory chip; what the read does past its end is unknown.
  - In flashing mode the reader refuses without sending anything.
- GD-77, DM-1801: the log shows the identification the radio gave (`MD-760P` for a
  GD-77, `1801` for a DM-1801). Watch whether the radio's screen goes back to normal
  after the read. The calibration is asked for at 0x7C00 after the codeplug; the backup says
  if the radio did not give it, and then has no radio ID.
- RT-4D: only block reads are sent, without the programming software's "open" and
  "close". If block 0 reads but later blocks time out, the open may be needed after
  all. If block 0 fails with "the answer starts with …", the message shows what the
  radio really sent.
- RT-4D: the page reads all 16 MiB, blocks 0 to 16383. The tool it follows stops after
  block 4095, so nobody is known to have asked a real radio for the blocks above, where
  the address book is. The first thing to watch is block 4096. If the radio stops
  answering there, the backup keeps the first 4 MiB and is marked incomplete. If it
  answers with the first 4 MiB over again, the page notices, keeps the first 4 MiB and
  says so. Either way, write down which.
- RT-4D: record how long the read takes. The page says about half an hour, which is an
  estimate: 16,384 blocks of 1,032 bytes at 115200 baud are 24.5 minutes on the wire,
  before the radio's own time per block.
- The radio ID of a GD-77, DM-1801 or RT-4D backup is a fingerprint of its calibration
  data, not a serial number. It should be the same on a second read of the same radio.
- The page skips the read for a radio whose ID matches a complete backup it holds, but
  only where the ID is known to be the radio's own (`idIsPerUnit` in `src/radios.ts`):
  the C62's chip ID, a TYT radio's unique ID, and the USB serial number of an STM32F405
  in DFU mode (Module 17, CS7000-M17). On a TYT radio the ID comes from the info blocks,
  before program mode, so a recognised radio keeps running and does not restart; on a
  C62 reading the chip ID ends flashing mode, as a full read does.
- Open, to confirm on real radios, two of a model each: that two radios never report the
  same ID. Until it is confirmed these are read every time, and their backups still carry
  the ID:
  - CS7000-M17 Plus: whether the STM32H743 bootloader's USB serial number differs
    between radios, or is the same on all of them.
  - RT-4D, RT-950 Pro: whether two radios can have the same calibration, and so the same
    fingerprint; and that an RT-4D's fingerprint does not change when its settings do.
  - Module 17, CS7000-M17: the STM32F405 bootloader derives its serial number from the
    chip's unique ID, so the read is still skipped on a match; check it on two radios
    all the same.

## TYT (MD-380, MD-UV380, MD-9600, DM-1701)

- The TYT bootloader and the STM32 ROM share USB ID 0483:df11. The page picks the
  flasher by the radio chosen, not by ID. Choosing a TYT radio while a bare STM32 is
  plugged in fails at the first command (`91 31`) with a clear message. The other way
  round would raw-write a TYT radio, so do not pick Module 17 or CS7000 for one.
- After each erase the page asks for status twice without waiting, as radio_tool does.
  If Chrome's timing differs from libusb's it shows as "The radio failed the erase".
- Blocks are 1024 bytes because radio_tool sends that; the bootloader's limit is unknown.
- There is no read-back, so "done" means every block was acknowledged. Boot the radio.
- No reset command is sent: power-cycle by hand.

## STM32 DFU (Module 17, CS7000-M17, CS7000-M17 Plus)

- The log should say the block size (2048 on F405, 1024 on H743) and not mention the
  "built-in layout": that means the flash layout was read from the device.
- The first 128 K sector erase takes one to two seconds.
- A read-protected chip fails at verify, after the write.
- Module 17 boards with a GD32 (28e9:0189) are assumed to behave like ST's ROM.
- CS7000-M17 Plus: the `.dfu` puts OpenRTX at 0x08100000 beside the Connect Systems
  bootloader. Measured 2026-11-24 on a radio just put back to its Connect Systems
  bootloader (B7.06) and DMR firmware: in DFU mode the ROM refuses the first set-address
  with errVENDOR, for the flash and for the option bytes, and `dfu-util` gets the same
  answer. Nothing is erased or written. The same radio took DFU reads and writes before
  that firmware had started once, so the reading is that it read-protects the chip. A
  radio in that state can only be flashed in robot mode (below).
- Windows: ST's DfuSe driver blocks WebUSB until Zadig installs WinUSB.

## CS7000-M17 Plus in robot mode (command line only)

- PTT + the orange button on top at power-on. The radio is then a USB drive without a
  disk, 0483:5720 "Mass Storage in FS Mode", one Bulk-Only interface, 64-byte endpoints.
  A browser does not hand that kind of device to a page, so only the command line has
  this mode (`commandLine` in src/radios.ts).
- macOS keeps the drive for its own driver: without `sudo` the claim fails with
  LIBUSB_ERROR_ACCESS and the tool says so. With `sudo`, libusb takes the device over
  for the run, and robot mode survives that (the device is enumerated again).
- First run on a radio, 2026-11-24 (bootloader B7.06, macOS on Apple silicon, Node 26.9,
  `sudo`): the connect was answered with 24 and all 107 blocks of a 218,296-byte build
  were taken, with no answer other than 21. Not learned from it: what the radio does
  when asked for an answer it does not have (the simulator covers zeroes, a status in
  place of the data, a stall and a fetch that runs out of time), and Linux.
- The log should say "Connected to the radio's bootloader (it answered 24)", then the
  block count. Answers other than 21 to a block or the commit are logged, not fatal: the
  Factory Tool goes by the answer's command alone.
- Nothing can be read back in this mode. The check is the radio itself: SK3 at power-on
  starts OpenRTX, no key starts the DMR firmware, which a failed write leaves alone.
- Windows keeps the device too, and libusb cannot take it there: the Factory Tool.

## GD-77, DM-1801 (WebHID)

- First exchange: `DOWNLOAD` must be answered with `#UPDATE?`. If not, compare the
  framing line in the log with the device's report descriptor (assumed: output report 1,
  input report 3, 41 bytes). `Gd77Options.framing` overrides it without a code change.
- `PROGRAM` is sent ending in 0x0F as the Python loader does (radio_tool sends 0xFF).
- The erase must answer within five seconds.
- The last data frame carries one byte (payloads are 0x77001 / 0x78001 long).
- Linux: needs a udev rule for hidraw, and the bootloader's OUT endpoint may be bulk, in
  which case the kernel may send output reports where the bootloader does not listen.
  That would show as a timeout on Linux only.

## RT-4D (Web Serial)

- "Hold PTT while turning on" is not in the reference flasher; confirm how the
  bootloader is entered.
- The probe reply's length is unknown; the flasher takes the first byte and waits for
  100 ms of quiet.
- The 16-bit offset in each write wraps every 64 KiB, as in the reference. Blocks past
  the first 64 KiB can only be checked by booting.
- The image is padded with zeros to 246 KiB and all of it is written.

## RT-950 Pro (Web Serial, Radtel's bootloader)

- Not run on a radio yet. The protocol is the one in `scripts/rt950_flash.py` of
  Marko13's OpenRTX port (branch rt950pro, 7c8ac095), direct path only: the radio is
  switched on in the bootloader by holding both side keys.
- The bootloader cannot be read, so nothing is read back after writing; a good flash
  shows only by the radio starting OpenRTX.
- A data block that gets no answer, or "wrong data length", is sent again up to five
  times, as in the reference: the radio drops bytes while it writes a flash page.
- The page checks the model name at 0x3E0 of the `.BTF` before it opens the port. The
  bootloader checks it again.
- The bootloader (first 12 KiB) is never written. Radtel's firmware file, from
  https://www.radtels.com/pages/software-download, is the way back; it is a `.BTF`
  with the same model name at 0x3E0, so this page should flash it too. Not tried.
- Backup, not run on a radio yet: with Radtel's firmware running, the programming
  protocol reads the memory chip at a 16-bit address, so 64 KiB in 128-byte blocks:
  channels, VFOs, settings, DTMF, APRS and the calibration areas at 0xE000, 0xF000 and
  0xF200 (addresses from Hertzz58's `cps_flash.py`; Ferrite puts factory calibration at
  0x00F000). The rest of the 4 MiB chip (fonts, start-up picture) is out of reach.
- To check on the bench: that the handshake is the raw one of `cps_flash.py` and not
  the framed one in the same repository's `docs/cps-uart.md`; that firmware newer than
  V0.27 still speaks it; that the model reply starts with `RT-950`; that the lone `06`
  puts the radio back to normal; how long the read takes; and whether the area from
  0xF000 really differs between two radios, since its checksum is used as the radio's
  ID. The 16 bytes of identity from the handshake are kept in the backup's notes for
  that comparison.
- The drawing's key positions are a guess from the port's key map, not from a radio.

## C62 / C2 (Web Serial, cskburn)

- Flashing mode (LISTENAI's burn mode) has to be entered again before every attempt.
  After a backup the page sends the user back to the flashing-mode step for that.
- The chip verifies each partition with its own MD5; a pass is a real read-back.
- PL2303 cables and FTDI above 115200 baud have stalled with native cskburn; start with
  a CP2102 at 115200.
- Two images are written in one run, as OpenRTX's own flashing does: `dsp_firmware.bin`
  at 0x100000, then `zephyr.bin` at 0x0. OpenRTX loads its DSP firmware from 0x100000 at
  every start. A build without `dsp_firmware.bin` can still be flashed, with a warning:
  that is only right for a radio that already runs OpenRTX. Restoring a backup writes
  the whole flash, DSP included.
- Restoring a backup, not run on a radio yet: the run asks the chip for its ID first
  (`--chip-id` with the image, one cskburn run) and stops before anything is erased when
  it is not the ID in the backup. The page's cskburn sends nothing more once the ID is
  wrong. The command line's cskburn is a separate program that does not wait, so it is
  also asked to read 16 KiB (`--read 0x0:0x4000:guard.bin`) between the ID and the write:
  over a second at 115200 baud, in which the program is ended. To confirm on the bench:
  that cskburn takes `--chip-id`, `--read` and an image in one run on a C62, and reads
  before it erases, as its source says.
- First runs on a real C62 (21 Nov 2026, Chrome on macOS, a Prolific cable):
  - The page's backup of all 4 MiB was identical to a `cskburn --read` dump of the same
    radio, except for 12,816 bytes in 0x3B1A90–0x3B4FAF that the original firmware
    rewrote when it ran in between (its settings area).
  - The page then wrote `zephyr.bin` only, which was all it did at the time. The radio
    started with a black screen: its console stops after "Auto load DSP firmware from
    partition@100000" and "Initializing LSF service controller", where a good start goes
    on to "DSP synced". The original firmware's own image was still at 0x100000. This
    was fixed by writing the second image; flashed again with both, the radio started
    OpenRTX.
