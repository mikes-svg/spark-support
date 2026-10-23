import { describe, expect, it } from 'vitest';
import { isTaskDone, isTaskLive, isTaskOverdue, isTaskWaiting } from './types';

// These four predicates are the load-bearing rule of the whole task model:
// every count, digest, and carryover decision keys off statusType and never off
// a status label. A test that passes a label-shaped value and still gets the
// right answer is the cheapest guard against that rule quietly eroding.
describe('task status predicates', () => {
  it('treats done and closed as finished, and nothing else', () => {
    expect(isTaskDone({ statusType: 'done' })).toBe(true);
    expect(isTaskDone({ statusType: 'closed' })).toBe(true);
    expect(isTaskDone({ statusType: 'active' })).toBe(false);
    expect(isTaskDone({ statusType: 'scheduled' })).toBe(false);
  });

  it('counts only live work, excluding scheduled and finished tasks', () => {
    expect(isTaskLive({ statusType: 'todo' })).toBe(true);
    expect(isTaskLive({ statusType: 'active' })).toBe(true);
    expect(isTaskLive({ statusType: 'waiting' })).toBe(true);
    expect(isTaskLive({ statusType: 'scheduled' })).toBe(false);
    expect(isTaskLive({ statusType: 'done' })).toBe(false);
  });

  it('identifies waiting-on tasks by type, not by a "PENDING <person>" label', () => {
    expect(isTaskWaiting({ statusType: 'waiting' })).toBe(true);
    expect(isTaskWaiting({ statusType: 'active' })).toBe(false);
  });

  it('is overdue strictly before today, and never for finished or pre-live tasks', () => {
    const today = '2026-09-23';
    expect(isTaskOverdue({ statusType: 'todo', dueDate: '2026-09-22' }, today)).toBe(true);
    // Due today is not yet late — matches isOverdue() in src/lib/onboarding.ts.
    expect(isTaskOverdue({ statusType: 'todo', dueDate: today }, today)).toBe(false);
    expect(isTaskOverdue({ statusType: 'done', dueDate: '2026-01-01' }, today)).toBe(false);
    expect(isTaskOverdue({ statusType: 'scheduled', dueDate: '2026-01-01' }, today)).toBe(false);
    expect(isTaskOverdue({ statusType: 'todo', dueDate: null }, today)).toBe(false);
  });
});
