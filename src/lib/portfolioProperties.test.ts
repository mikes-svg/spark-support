import { describe, expect, it } from 'vitest';
import { parsePropertyNames } from './portfolioProperties';

describe('parsePropertyNames', () => {
  it('splits pasted text on lines and commas, trims, and drops blanks', () => {
    expect(parsePropertyNames('Aura\n  Windsor  \n\n, Stone Ridge', [])).toEqual(['Aura', 'Windsor', 'Stone Ridge']);
  });

  it('de-duplicates within the paste and against existing names, ignoring case', () => {
    expect(parsePropertyNames('aura\nAura\nGrand View\ngrand view', ['AURA'])).toEqual(['Grand View']);
  });

  it('returns nothing for empty input', () => {
    expect(parsePropertyNames('  \n , \n', ['Aura'])).toEqual([]);
  });
});
