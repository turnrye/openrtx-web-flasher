// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { pickContributors, pictureType, sizedPicture } from './community.mjs';

describe('pickContributors', () => {
  it('leaves out bots and anonymous entries, and puts the most contributions first', () => {
    const people = pickContributors([
      {
        login: 'b',
        id: 2,
        html_url: 'https://github.com/b',
        avatar_url: 'https://a/2',
        contributions: 3,
        type: 'User',
      },
      { login: 'dependabot[bot]', id: 9, html_url: 'x', avatar_url: 'y', contributions: 50, type: 'Bot' },
      { name: 'Anonymous', contributions: 99, type: 'Anonymous' },
      {
        login: 'a',
        id: 1,
        html_url: 'https://github.com/a',
        avatar_url: 'https://a/1',
        contributions: 7,
        type: 'User',
      },
      {
        login: 'c',
        id: 3,
        html_url: 'https://github.com/c',
        avatar_url: 'https://a/3',
        contributions: 3,
        type: 'User',
      },
    ]);
    expect(people.map((p) => p.login)).toEqual(['a', 'b', 'c']);
    expect(people[0]).toEqual({
      login: 'a',
      id: 1,
      url: 'https://github.com/a',
      picture: 'https://a/1',
      contributions: 7,
    });
  });
});

describe('pictureType', () => {
  it('names PNG, JPEG, GIF and WebP from their first bytes, and nothing else', () => {
    expect(pictureType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe('png');
    expect(pictureType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe('jpg');
    expect(pictureType(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39))).toBe('gif');
    expect(pictureType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(
      'webp',
    );
    expect(pictureType(new TextEncoder().encode('<svg xmlns='))).toBeNull();
  });
});

describe('sizedPicture', () => {
  it('asks GitHub for the picture at twice the size the page shows', () => {
    expect(sizedPicture('https://avatars.githubusercontent.com/u/1?v=4')).toBe(
      'https://avatars.githubusercontent.com/u/1?v=4&s=96',
    );
  });
});
