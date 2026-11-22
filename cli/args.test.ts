// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parse, UsageError } from './args.ts';

describe('command line arguments', () => {
  it('shows the help when nothing or --help is given', () => {
    expect(parse([]).command).toEqual({ name: 'help' });
    expect(parse(['--help']).command).toEqual({ name: 'help' });
    expect(parse(['flash', '-h']).command).toEqual({ name: 'help' });
    expect(parse(['--version']).command).toEqual({ name: 'version' });
  });

  it('reads each command and its words', () => {
    expect(parse(['radios']).command).toEqual({ name: 'radios', radio: undefined });
    expect(parse(['radios', 'c62']).command).toEqual({ name: 'radios', radio: 'c62' });
    expect(parse(['firmware']).command).toEqual({ name: 'firmware' });
    expect(parse(['ports']).command).toEqual({ name: 'ports' });
    expect(parse(['backup', 'md9600']).command).toEqual({ name: 'backup', radio: 'md9600' });
    expect(parse(['fetch', 'mod17', 'v0.4.5']).command).toEqual({
      name: 'fetch',
      radio: 'mod17',
      firmware: 'v0.4.5',
    });
    expect(parse(['flash', 'c62', './build.zip']).command).toEqual({
      name: 'flash',
      radio: 'c62',
      firmware: './build.zip',
    });
  });

  it('writes nothing unasked: every safeguard is off only when its flag is given', () => {
    expect(parse(['flash', 'c62', 'master']).options).toEqual({
      out: '.',
      yes: false,
      experimental: false,
      again: false,
    });
    const { options } = parse(['flash', 'c62', 'master', '-y', '--experimental', '--again']);
    expect(options).toMatchObject({ yes: true, experimental: true, again: true });
  });

  it('takes options before, between and after the words', () => {
    const { command, options } = parse([
      '--port',
      '/dev/ttyUSB0',
      'backup',
      '--out=backups',
      'c62',
      '--repo',
      'someone/OpenRTX',
      '--cskburn',
      '/opt/cskburn',
    ]);
    expect(command).toEqual({ name: 'backup', radio: 'c62' });
    expect(options).toMatchObject({
      port: '/dev/ttyUSB0',
      out: 'backups',
      repo: 'someone/OpenRTX',
      cskburn: '/opt/cskburn',
    });
  });

  it('reads --sim as the page reads ?sim=', () => {
    expect(parse(['backup', 'c62']).options.sim).toBeUndefined();
    expect(parse(['backup', 'c62', '--sim']).options.sim).toBe('1');
    expect(parse(['--sim', 'backup', 'c62']).options.sim).toBe('1');
    expect(parse(['backup', 'c62', '--sim=wrongmode']).options.sim).toBe('wrongmode');
  });

  it('refuses what it does not understand, in words for the person', () => {
    expect(() => parse(['flahs', 'c62', 'master'])).toThrow(new UsageError('There is no "flahs" command.'));
    expect(() => parse(['flash', 'c62'])).toThrow('"flash" needs a radio and a firmware.');
    expect(() => parse(['backup'])).toThrow('"backup" needs a radio.');
    expect(() => parse(['backup', 'c62', 'extra'])).toThrow('"backup" does not take "extra".');
    expect(() => parse(['ports', 'c62'])).toThrow('"ports" does not take "c62".');
    expect(() => parse(['flash', 'c62', 'master', '--force'])).toThrow(UsageError);
    expect(() => parse(['backup', 'c62', '--port'])).toThrow(UsageError);
  });
});
