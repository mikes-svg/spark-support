import { describe, expect, it } from 'vitest';
import { applyToSubtasks, namesAlreadyAdded, subtasksFromNames } from './subtasks';
import type { Subtask } from '../types';

const row = (id: string, title: string, order: number, extra: Partial<Subtask> = {}): Subtask =>
  ({ id, title, done: false, order, ...extra });

describe('subtasksFromNames', () => {
  it('appends one subtask per property after the existing rows, in order', () => {
    let n = 0;
    const out = subtasksFromNames([row('a', 'Order signs', 0)], ['Aura', 'Windsor'], () => `new-${++n}`);
    expect(out.map((s) => [s.id, s.title, s.order, s.done])).toEqual([
      ['a', 'Order signs', 0, false],
      ['new-1', 'Aura', 1, false],
      ['new-2', 'Windsor', 2, false],
    ]);
  });

  it('skips names already present (ignoring case and spaces) and blanks', () => {
    let n = 0;
    const out = subtasksFromNames([row('a', 'aura ', 0)], ['Aura', '  ', 'Windsor', 'windsor'], () => `new-${++n}`);
    expect(out.map((s) => s.title)).toEqual(['aura ', 'Windsor']);
  });

  it('re-derives contiguous order even when the input had gaps', () => {
    const out = subtasksFromNames([row('b', 'B', 7), row('a', 'A', 2)], ['C'], () => 'c');
    expect(out.map((s) => [s.title, s.order])).toEqual([['A', 0], ['B', 1], ['C', 2]]);
  });
});

describe('namesAlreadyAdded', () => {
  it('reports which property names already exist as subtasks', () => {
    const have = namesAlreadyAdded([row('a', 'Aura', 0), row('b', 'The Windsor', 1)], ['Aura', 'Windsor', 'the windsor']);
    expect([...have]).toEqual(['Aura', 'the windsor']);
  });
});

describe('applyToSubtasks', () => {
  const rows = [
    row('a', 'Aura', 0, { assigneeIds: ['u1'], dueDate: '2026-11-01' }),
    row('b', 'Windsor', 1, { done: true }),
  ];

  it('sets assignees on every row and leaves due dates alone', () => {
    const out = applyToSubtasks(rows, { assigneeIds: ['u2', 'u3'] });
    expect(out.map((s) => s.assigneeIds)).toEqual([['u2', 'u3'], ['u2', 'u3']]);
    expect(out.map((s) => s.dueDate)).toEqual(['2026-11-01', undefined]);
  });

  it('sets a due date on every row and leaves assignees alone', () => {
    const out = applyToSubtasks(rows, { dueDate: '2026-12-15' });
    expect(out.map((s) => s.dueDate)).toEqual(['2026-12-15', '2026-12-15']);
    expect(out[0].assigneeIds).toEqual(['u1']);
  });

  it('can skip finished rows, and stores an empty date as null', () => {
    const out = applyToSubtasks(rows, { dueDate: '' , assigneeIds: [] }, true);
    expect(out[0]).toMatchObject({ assigneeIds: [], dueDate: null });
    expect(out[1]).toBe(rows[1]);
  });
});
