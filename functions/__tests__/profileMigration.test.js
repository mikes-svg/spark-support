/**
 * The invited-slug → real-UID rewrite. A miss here is invisible in the UI: the
 * person signs in and simply has nothing assigned, so every case asserts the
 * exact patch, not just "something changed".
 */
import { describe, it, expect } from 'vitest';
import migration from '../profileMigration.js';

const { REFERENCES, rewriteReferences } = migration;
const spec = (name) => REFERENCES.find((r) => r.collection === name);
const FROM = ['acc1_sparkmanage_com'];
const TO = 'uid_adrian';

describe('rewriteReferences', () => {
  it('moves a task’s assignee, watcher and participant entries, deduping against the new id', () => {
    const data = {
      assigneeIds: ['acc1_sparkmanage_com', 'uid_greg'],
      watcherIds: ['uid_greg'],
      participants: ['uid_greg', 'acc1_sparkmanage_com', 'uid_adrian'],
      creatorId: 'acc1_sparkmanage_com',
      waitingOnUserId: null,
    };
    expect(rewriteReferences(spec('tasks'), data, FROM, TO)).toEqual({
      assigneeIds: ['uid_adrian', 'uid_greg'],
      participants: ['uid_greg', 'uid_adrian'],
      creatorId: 'uid_adrian',
    });
  });

  it('returns null when nothing references the old id', () => {
    const data = { assigneeIds: ['uid_greg'], watcherIds: [], participants: ['uid_greg'], creatorId: 'uid_greg' };
    expect(rewriteReferences(spec('tasks'), data, FROM, TO)).toBeNull();
  });

  it('rewrites ids inside stages and subtasks, leaving untouched items identical', () => {
    const untouched = { id: 's2', title: 'Review', assigneeIds: ['uid_greg'], completedBy: null };
    const data = {
      assigneeIds: ['acc1_sparkmanage_com'],
      stages: [{ id: 's1', title: 'Prep', assigneeIds: ['acc1_sparkmanage_com'], completedBy: 'acc1_sparkmanage_com' }, untouched],
      subtasks: [{ id: 'a', title: 'x', done: true, doneBy: 'acc1_sparkmanage_com', assigneeIds: [] }],
    };
    const patch = rewriteReferences(spec('tasks'), data, FROM, TO);
    expect(patch.stages[0]).toEqual({ id: 's1', title: 'Prep', assigneeIds: ['uid_adrian'], completedBy: 'uid_adrian' });
    expect(patch.stages[1]).toBe(untouched);
    expect(patch.subtasks[0].doneBy).toBe('uid_adrian');
  });

  it('reaches into a series payload with dotted paths', () => {
    const data = { creatorId: 'uid_greg', payload: { assigneeIds: ['acc1_sparkmanage_com', 'uid_ren'], watcherIds: ['uid_greg'] } };
    expect(rewriteReferences(spec('taskSeries'), data, FROM, TO)).toEqual({ 'payload.assigneeIds': ['uid_adrian', 'uid_ren'] });
  });

  it('re-attributes comments and events', () => {
    expect(rewriteReferences(spec('taskComments'), { userId: 'acc1_sparkmanage_com', mentionedIds: [] }, FROM, TO)).toEqual({ userId: 'uid_adrian' });
    expect(rewriteReferences(spec('taskEvents'), { actorId: 'uid_greg', toAssigneeIds: ['acc1_sparkmanage_com'] }, FROM, TO)).toEqual({ toAssigneeIds: ['uid_adrian'] });
  });

  it('covers tickets and default-assignee settings, including the legacy scalar fields', () => {
    expect(rewriteReferences(spec('tickets'), { assigneeIds: ['acc1_sparkmanage_com'], assigneeId: 'acc1_sparkmanage_com', submitterId: 'uid_x' }, FROM, TO))
      .toEqual({ assigneeIds: ['uid_adrian'], assigneeId: 'uid_adrian' });
    expect(rewriteReferences(spec('requestTypes'), { defaultAssigneeIds: ['uid_greg', 'acc1_sparkmanage_com'] }, FROM, TO))
      .toEqual({ defaultAssigneeIds: ['uid_greg', 'uid_adrian'] });
  });

  it('handles several old ids at once (two slug variants of the same person)', () => {
    const data = { assigneeIds: ['a_old', 'b_old', 'uid_greg'], watcherIds: [], participants: ['a_old'], creatorId: 'b_old' };
    expect(rewriteReferences(spec('tasks'), data, ['a_old', 'b_old'], TO)).toEqual({
      assigneeIds: ['uid_adrian', 'uid_greg'], participants: ['uid_adrian'], creatorId: 'uid_adrian',
    });
  });
});
