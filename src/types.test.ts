import { describe, expect, it } from 'vitest';
import { canEditCategories } from './types';

describe('canEditCategories', () => {
  it('always lets an Administrator manage categories', () => {
    expect(canEditCategories({ role: 'superadmin' })).toBe(true);
    expect(canEditCategories({ role: 'superadmin', categoriesAccess: false })).toBe(true);
  });

  it('lets a Manager manage categories only once granted', () => {
    expect(canEditCategories({ role: 'admin' })).toBe(false);
    expect(canEditCategories({ role: 'admin', categoriesAccess: false })).toBe(false);
    expect(canEditCategories({ role: 'admin', categoriesAccess: true })).toBe(true);
  });

  it('never lets a User manage categories, even with the flag set', () => {
    expect(canEditCategories({ role: 'user', categoriesAccess: true })).toBe(false);
    expect(canEditCategories(null)).toBe(false);
    expect(canEditCategories(undefined)).toBe(false);
  });
});
