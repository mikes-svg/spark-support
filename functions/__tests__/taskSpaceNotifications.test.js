/**
 * The space mute is resolved task → list → space, fails open, and reads each
 * document once per cache. Driven against a fake Firestore so firebase-admin
 * never initialises.
 */

import { describe, it, expect } from 'vitest';
import mod from '../taskSpaceNotifications.js';

const { isSpaceMuted, createMuteCache, isTaskInMutedSpace, mutedListIds } = mod;

/** Minimal fake of the Admin SDK surface the module touches. */
function fakeDb(data, reads = []) {
  const docSnap = (collection, id) => {
    reads.push(`${collection}/${id}`);
    const d = data[collection]?.[id];
    return { exists: Boolean(d), id, data: () => d };
  };
  return {
    collection: (name) => ({
      doc: (id) => ({ get: async () => docSnap(name, id) }),
      get: async () => {
        reads.push(`${name}/*`);
        return { docs: Object.entries(data[name] ?? {}).map(([id, d]) => ({ id, data: () => d })) };
      },
    }),
  };
}

const DATA = {
  taskSpaces: {
    quiet: { name: 'Quiet', notificationsMuted: true },
    loud: { name: 'Loud', notificationsMuted: false },
    legacy: { name: 'Legacy' },
  },
  taskLists: {
    'l-quiet': { spaceId: 'quiet' },
    'l-loud': { spaceId: 'loud' },
    'l-legacy': { spaceId: 'legacy' },
    'l-orphan': {},
  },
};

describe('isSpaceMuted', () => {
  it('is true only for an explicit notificationsMuted: true', () => {
    expect(isSpaceMuted({ notificationsMuted: true })).toBe(true);
    expect(isSpaceMuted({ notificationsMuted: false })).toBe(false);
    expect(isSpaceMuted({})).toBe(false);
    expect(isSpaceMuted(undefined)).toBe(false);
    expect(isSpaceMuted({ notificationsMuted: 'true' })).toBe(false);
  });
});

describe('isTaskInMutedSpace', () => {
  it('mutes a task whose list belongs to a muted space', async () => {
    expect(await isTaskInMutedSpace(fakeDb(DATA), { listId: 'l-quiet' })).toBe(true);
  });

  it('leaves a task in an unmuted or legacy space alone', async () => {
    expect(await isTaskInMutedSpace(fakeDb(DATA), { listId: 'l-loud' })).toBe(false);
    expect(await isTaskInMutedSpace(fakeDb(DATA), { listId: 'l-legacy' })).toBe(false);
  });

  it('fails open for a missing list, a list without a space, or no listId', async () => {
    expect(await isTaskInMutedSpace(fakeDb(DATA), { listId: 'nope' })).toBe(false);
    expect(await isTaskInMutedSpace(fakeDb(DATA), { listId: 'l-orphan' })).toBe(false);
    expect(await isTaskInMutedSpace(fakeDb(DATA), {})).toBe(false);
    expect(await isTaskInMutedSpace(fakeDb(DATA), null)).toBe(false);
  });

  it('fails open when Firestore throws', async () => {
    const broken = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('boom'); } }) }) };
    expect(await isTaskInMutedSpace(broken, { listId: 'l-quiet' })).toBe(false);
  });

  it('reads each list and space once per cache', async () => {
    const reads = [];
    const db = fakeDb(DATA, reads);
    const cache = createMuteCache();
    await isTaskInMutedSpace(db, { listId: 'l-quiet' }, cache);
    await isTaskInMutedSpace(db, { listId: 'l-quiet' }, cache);
    await isTaskInMutedSpace(db, { listId: 'l-loud' }, cache);
    expect(reads).toEqual(['taskLists/l-quiet', 'taskSpaces/quiet', 'taskLists/l-loud', 'taskSpaces/loud']);
  });
});

describe('mutedListIds', () => {
  it('returns the lists of every muted space', async () => {
    expect([...(await mutedListIds(fakeDb(DATA)))]).toEqual(['l-quiet']);
  });

  it('skips the list scan when nothing is muted', async () => {
    const reads = [];
    const db = fakeDb({ taskSpaces: { loud: { notificationsMuted: false } }, taskLists: DATA.taskLists }, reads);
    expect((await mutedListIds(db)).size).toBe(0);
    expect(reads).toEqual(['taskSpaces/*']);
  });

  it('fails open to an empty set when Firestore throws', async () => {
    const broken = { collection: () => ({ get: async () => { throw new Error('boom'); } }) };
    expect((await mutedListIds(broken)).size).toBe(0);
  });
});
