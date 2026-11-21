# What to watch on the first bench run

Each flasher was written from a reference tool and tested against a simulator. These are
the points where the real radio could differ. The "Details" box on the page logs enough
to tell which one it was.

## Backups

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

### Through the original firmware (TYT, GD-77, DM-1801, RT-4D)

None of these reads has been run from the page on a radio. Each reader sends only read
requests and its simulator fails the test on anything else, but what a real radio
answers is known from other tools, and for the TYT family from one MD-9600.

- The page cannot write these backups back. They are a record: codeplug, settings and
  the factory data. Compare the first one of each model with a read made by the usual
  programming software.
- TYT: info blocks, one snapshot of the first 64 KB of internal flash (the bootloader),
  then the SPI flash in program mode, then `91 05`, on which the radio restarts.
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
  radio really sent. Expect about seven minutes for the 4 MB the page reads.
- The radio ID of a GD-77, DM-1801 or RT-4D backup is a fingerprint of its calibration
  data, not a serial number. It should be the same on a second read of the same radio.
- The page skips the read for a radio whose ID matches a complete backup it holds. Two
  things to confirm on real radios: that two radios of one model never report the same
  ID (the STM32 bootloader's USB serial number is the one to watch), and that an RT-4D's
  fingerprint does not change when its settings do. On a TYT radio the ID comes from the
  info blocks, before program mode, so a recognised radio keeps running and does not
  restart; on a C62 reading the chip ID ends flashing mode, as a full read does.

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
  bootloader. Open question: does that bootloader start OpenRTX (SK3 at power-on) after
  a DFU write, or only after its own Factory Tool wrote it? Check the DMR firmware still
  starts too.
- Windows: ST's DfuSe driver blocks WebUSB until Zadig installs WinUSB.

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
- The page has no backup for this radio. The bootloader (first 12 KiB) is never
  written, so Radtel's update tool and firmware file are the way back.
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
