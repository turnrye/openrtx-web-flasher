// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from './md5.ts';

describe('md5', () => {
  it('matches Node for a range of lengths', () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 70000]) {
      const data = new Uint8Array(randomBytes(length));
      expect(Buffer.from(md5(data)).toString('hex')).toBe(createHash('md5').update(data).digest('hex'));
    }
  });
});
