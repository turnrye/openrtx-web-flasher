// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cs7000Robot } from '../src/drivers/cs7000-robot.ts';
import { DFU_FILTERS } from '../src/drivers/shared.ts';
import { GD77_HID_FILTER } from '../src/flash/gd77.ts';

/** The robot mode bootloader's IDs, and the GD-77 family's. */
const CS7000_ROBOT_FILTERS = cs7000Robot.filters;
const GD77_FILTERS = [GD77_HID_FILTER];
import { folder, removeFolders } from './test-support.ts';
import { installSteps, RULES_PATH, rulesState, shown, udevRules } from './udev.ts';

afterAll(removeFolders);

/** "0483" from 0x0483, as udev writes an ID. */
const hex = (id?: number) => (id ?? 0).toString(16).padStart(4, '0');

describe('the udev rule file', () => {
  const rules = udevRules();
  const lines = rules.split('\n').filter((l) => l && !l.startsWith('#'));

  it('gives every device a flasher opens to whoever is logged in, and nothing else', () => {
    const usb = [...DFU_FILTERS, ...CS7000_ROBOT_FILTERS].map(
      (f) => `ATTR{idVendor}=="${hex(f.vendorId)}", ATTR{idProduct}=="${hex(f.productId)}"`,
    );
    const hid = GD77_FILTERS.map(
      (f) => `ATTRS{idVendor}=="${hex(f.vendorId)}", ATTRS{idProduct}=="${hex(f.productId)}"`,
    );
    expect(lines).toHaveLength(usb.length + hid.length);
    for (const id of usb)
      expect(lines.some((l) => l.startsWith('SUBSYSTEM=="usb"') && l.includes(id))).toBe(true);
    for (const id of hid)
      expect(lines.some((l) => l.startsWith('KERNEL=="hidraw*"') && l.includes(id))).toBe(true);
    // uaccess only: no MODE that opens a device to every user, no group that may not exist.
    for (const line of lines) {
      expect(line.endsWith('TAG+="uaccess"')).toBe(true);
      expect(line).not.toMatch(/MODE|GROUP/);
    }
  });

  it('names the radios each rule is for', () => {
    expect(rules).toContain('# Connect Systems robot mode (a USB drive): Connect Systems CS7000-M17 Plus');
    expect(rules).toMatch(/# NXP bootloader of the GD-77 family \(USB HID\): .*Radioddity GD-77/);
  });

  it('is numbered below 73, where systemd acts on uaccess', () => {
    expect(Number(/^(\d+)-/.exec(basename(RULES_PATH))![1])).toBeLessThan(73);
    expect(RULES_PATH.startsWith('/etc/udev/rules.d/')).toBe(true);
  });

  it('is installed with sudo, reloaded and applied to devices already connected', () => {
    const steps = installSteps('/tmp/x/70-openrtx-flasher.rules');
    expect(steps.map(shown)).toEqual([
      `sudo install -m 0644 /tmp/x/70-openrtx-flasher.rules ${RULES_PATH}`,
      'sudo udevadm control --reload',
      'sudo udevadm trigger --action=change --subsystem-match=usb --subsystem-match=hidraw',
    ]);
    expect(shown({ command: 'sudo', args: ['install', '/tmp/a b'] })).toBe("sudo install '/tmp/a b'");
  });

  it('tells a missing, a current and an older file apart', () => {
    const path = join(folder(), '70-openrtx-flasher.rules');
    expect(rulesState(path)).toBe('missing');
    writeFileSync(path, rules);
    expect(rulesState(path)).toBe('current');
    writeFileSync(path, '# an older version\n');
    expect(rulesState(path)).toBe('outdated');
  });
});
