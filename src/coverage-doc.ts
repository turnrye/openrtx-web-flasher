// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Writes docs/backup-coverage.md from the coverage record, so the document cannot say
 * anything the record does not. coverage.test.ts compares the file with this text.
 */
import {
  closingText,
  coverageFor,
  gapsFor,
  isComplete,
  OPENRTX_LIMIT,
  sizeText,
  WORST_FIRST,
  type Closing,
  type MemoryCoverage,
} from './coverage.ts';
import { radioById, RADIOS, type Radio } from './radios.ts';

/** `text` with a capital first letter. */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Names joined as "A, B and C". */
function list(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The "Saved" cell. */
function savedWord(memory: MemoryCoverage): string {
  return memory.saved === 'all' ? 'all' : memory.saved === 'part' ? '**part**' : '**none**';
}

/** The "Run on a real radio" cell. */
function checkWord(memory: MemoryCoverage): string {
  switch (memory.check) {
    case 'checked':
      return 'yes';
    case 'other-tool':
      return 'with another tool only';
    case 'unchecked':
      return 'no';
    case undefined:
      return 'nothing is read';
  }
}

/** How a gap closes, in full, as list items under the gap. `again` is true when the gap above closes the same way. */
function closingLines(close: Closing, again: boolean): string[] {
  if (again) return ['  - To close it: the same as the one above.'];
  switch (close.how) {
    case 'none-needed':
      return [];
    case 'read-more':
      return [`  - To close it: ${close.text}`];
    case 'other-tool':
      return [`  - To close it: [${close.tool}](${close.url}). ${close.text}`];
    case 'dumper':
      return [
        `  - To close it, a dumper: ${close.does}`,
        ...(close.cannot ? [`  - Limits of that dumper: ${close.cannot}`] : []),
      ];
  }
}

/** One radio's gaps, as a list. */
function gapLines(radio: Radio): string[] {
  return gapsFor(radio).flatMap((gap, i, gaps) => [
    `- **${capital(gap.name)}** (${sizeText(gap.bytes)}), ${gap.saved === 'none' ? 'not saved' : 'saved in part'}. It holds ${gap.holds}.`,
    `  - Saved: ${capital(gap.savedText)}.`,
    `  - Lost without it: ${gap.lost ?? ''}`,
    ...closingLines(gap.close, i > 0 && gaps[i - 1].close === gap.close),
    ...(gap.unverified ? [`  - Not confirmed: ${gap.unverified}`] : []),
  ]);
}

/**
 * The worst-first list as sections. Radios next to each other in the list whose gaps
 * read the same, word for word, share a section.
 */
function worstFirst(): string[] {
  const sections: { names: string[]; lines: string[] }[] = [];
  for (const id of WORST_FIRST) {
    const radio = radioById(id)!;
    const lines = gapLines(radio);
    const last = sections.at(-1);
    if (last?.lines.join('\n') === lines.join('\n')) last.names.push(radio.name);
    else sections.push({ names: [radio.name], lines });
  }
  return sections.flatMap((section, i) => [`### ${i + 1}. ${list(section.names)}`, '', ...section.lines, '']);
}

/** docs/backup-coverage.md, before Prettier lays out its table. */
export function coverageMarkdown(): string {
  const complete = RADIOS.filter(isComplete);
  const limited = RADIOS.filter((radio) => coverageFor(radio).needsOriginalFirmware);
  const lines = [
    '# Backup coverage',
    '',
    '<!-- Written from src/coverage.ts. Do not edit: change the record, then run `npm run coverage-doc`. -->',
    '',
    'What a backup made by this page, or by its command line, holds of each radio, memory by',
    'memory, and what it does not. Every memory that is not saved whole is a critical gap: once',
    'OpenRTX is on the radio, what was not saved may be gone for good. Where neither the',
    "radio's bootloader nor its original firmware gives a memory up, the gap needs a dumper;",
    '[dumper.md](dumper.md) says what that is.',
    '',
    `Of the ${RADIOS.length} radios, ${complete.length} are backed up whole: the ${list(complete.map((r) => r.name))}.`,
    `The other ${RADIOS.length - complete.length} have at least one critical gap.`,
    '',
    'The hardware facts are from a backup-coverage audit of 2026-11-26 and from the sources each',
    'reader names. "Not confirmed" marks what nobody has checked on a radio.',
    '',
    '## Every memory',
    '',
    '| Radio | Memory | Size | Saved | Run on a real radio | To close the gap |',
    '| --- | --- | --- | --- | --- | --- |',
    ...RADIOS.flatMap((radio) =>
      coverageFor(radio).memories.map(
        (memory) =>
          `| ${radio.name} | ${memory.name} | ${sizeText(memory.bytes)} | ${savedWord(memory)} | ${checkWord(memory)} | ${closingText(memory.close)} |`,
      ),
    ),
    '',
    '"Run on a real radio" is about this tool\'s own read. [bench-notes.md](bench-notes.md) and',
    '[verification.md](verification.md) have the record.',
    '',
    '## Critical gaps, worst first',
    '',
    'Ordered by what is lost for good and how soon flashing loses it.',
    '',
    ...worstFirst(),
    '## What is saved whole',
    '',
    ...RADIOS.flatMap((radio) =>
      coverageFor(radio)
        .memories.filter((memory) => memory.saved === 'all')
        .map(
          (memory) =>
            `- **${radio.name}**, ${memory.name} (${sizeText(memory.bytes)}): ${memory.savedText}. It holds ${memory.holds}.` +
            (memory.unverified ? ` Not confirmed: ${memory.unverified}` : ''),
        ),
    ),
    '',
    '## Radios that already run OpenRTX',
    '',
    OPENRTX_LIMIT,
    '',
    `This goes for the ${list(limited.map((r) => r.name))}.`,
    '',
    'The others are read without the help of the firmware they run. On a radio that runs',
    'OpenRTX such a read gives OpenRTX and its settings, not what the radio came with.',
    '',
    'OpenRTX has a routine that sends the memory chip over XMODEM (`openrtx/src/core/backup.c`),',
    'but nothing in the firmware calls it.',
    '',
  ];
  return lines.join('\n');
}
