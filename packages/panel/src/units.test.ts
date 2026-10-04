import { describe, expect, it } from 'vitest';
import { BASE_UNIT_FOR, UNITS, baseUnitOf, convert, formatQty, legacyBase, legacyFactor, toBaseQty, unitMismatch, unitTable } from './units';

describe('units', () => {
  it('converts within weight, volume and count, and refuses to mix them', () => {
    expect(convert(500, 'g', 'kg')).toBe(0.5);
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(1, 'lb', 'g')).toBe(453.59237);
    expect(convert(16, 'oz', 'lb')).toBeCloseTo(1, 4);
    expect(convert(2, 'cup', 'ml')).toBe(500);
    expect(convert(3, 'tsp', 'tbsp')).toBe(1);
    expect(convert(2, 'dozen', 'pcs')).toBe(24);
    expect(convert(1, 'kg', 'l')).toBeNull();
    expect(convert(1, 'kg', 'nonsense')).toBeNull();
  });

  it('turns typed amounts into the base unit with no floating-point crumbs', () => {
    expect(toBaseQty(250, 'kg', 'g')).toBe(0.25);
    expect(toBaseQty(0.1 + 0.2, 'kg')).toBe(0.3); // no unit: already base, just tidied
    expect(toBaseQty(1, 'kg', 'mg')).toBe(0.000001);
    expect(toBaseQty(350, 'l', 'ml')).toBe(0.35);
    expect(toBaseQty(2, 'pcs', 'dozen')).toBe(24);
    expect(toBaseQty(5, 'kg', 'ml')).toBeNull(); // a liquid unit for something weighed
    expect(toBaseQty(5, 'pcs', 'g')).toBeNull();
    expect(toBaseQty(5, 'kg', 'cubit')).toBeNull();
  });

  it('has a base unit of kg, l or pcs for every unit it knows, and every unit converts to its own base', () => {
    for (const u of UNITS) {
      expect(['kg', 'l', 'pcs']).toContain(baseUnitOf(u.code));
      expect(toBaseQty(1, BASE_UNIT_FOR[u.dimension], u.code)).toBe(Math.round(u.toBase * 1e6) / 1e6);
    }
    expect(new Set(UNITS.map((u) => u.code)).size).toBe(UNITS.length);
    expect(unitTable().find((u) => u.code === 'g')).toMatchObject({ base: 'kg', perUnit: 0.001 });
  });

  it('writes quantities the way a person says them', () => {
    expect(formatQty(0.25, 'kg')).toBe('250 g');
    expect(formatQty(1.5, 'kg')).toBe('1.5 kg');
    expect(formatQty(5, 'kg')).toBe('5 kg');
    expect(formatQty(0.0005, 'kg')).toBe('0.5 g');
    expect(formatQty(0.035, 'l')).toBe('35 ml');
    expect(formatQty(2, 'l')).toBe('2 l');
    expect(formatQty(0, 'kg')).toBe('0 kg');
    expect(formatQty(-0.25, 'kg')).toBe('-250 g');
    expect(formatQty(12, 'pcs')).toBe('12 pcs');
  });

  it('explains a unit that does not fit', () => {
    expect(unitMismatch('Eggs', 'pcs', 'kg')).toMatch(/Eggs is counted/);
    expect(unitMismatch('Milk', 'l', 'kg')).toMatch(/Milk is measured by volume/);
    expect(unitMismatch('Flour', 'kg', 'cubit')).toMatch(/not a unit/);
  });

  it('knows how old gram and millilitre data maps to the new base units', () => {
    expect([legacyFactor('g'), legacyFactor('ml'), legacyFactor('kg'), legacyFactor('pcs')]).toEqual([0.001, 0.001, 1, 1]);
    expect(['g', 'kg', 'ml', 'l', 'pcs'].map(legacyBase)).toEqual(['kg', 'kg', 'l', 'l', 'pcs']);
  });
});
