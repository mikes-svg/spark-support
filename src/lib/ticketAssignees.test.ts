import { describe, expect, it } from 'vitest';
import { assigneesAreValid, lockedAssigneeIds, assigneeIdsForTypeChange } from './ticketAssignees';
import { ticketParticipants } from '../types';
import type { Profile } from '../types';

const profiles: Record<string, Profile> = {
  mgr: { id: 'mgr', name: 'Manager', photoURL: '', role: 'admin' },
  usr: { id: 'usr', name: 'User', photoURL: '', role: 'user' },
};

describe('the last-Manager guard', () => {
  it('locks the only Manager on an individually-assigned ticket', () => {
    expect(lockedAssigneeIds(['mgr', 'usr'], profiles)).toEqual(['mgr']);
    expect(assigneesAreValid(['usr'], profiles)).toBe(false);
  });
});

describe('ticketParticipants', () => {
  it('is submitter + assignees, deduped', () => {
    expect(ticketParticipants({ submitterId: 'sub', status: 'Open' }, ['mgr', 'usr', 'sub']))
      .toEqual(['sub', 'mgr', 'usr']);
  });

  it('keeps everyone but the submitter off a Scheduled ticket until it goes live', () => {
    expect(ticketParticipants({ submitterId: 'sub', status: 'Scheduled' }, ['mgr'])).toEqual(['sub']);
  });

  it('drops empty ids rather than writing them into the array', () => {
    expect(ticketParticipants({ submitterId: 'sub' }, ['', 'mgr'])).toEqual(['sub', 'mgr']);
  });
});

describe('assigneeIdsForTypeChange', () => {
  const profiles2: Record<string, Profile> = {
    ...profiles,
    mgr2: { id: 'mgr2', name: 'Manager 2', photoURL: '', role: 'superadmin' },
    usr2: { id: 'usr2', name: 'User 2', photoURL: '', role: 'user' },
  };

  it("hands the ticket to the new type's default assignees, dropping the old ones", () => {
    expect(assigneeIdsForTypeChange(['mgr', 'usr'], ['mgr2', 'usr2'], profiles2)).toEqual(['mgr2', 'usr2']);
  });

  it('leaves the ticket unassigned when the type has no defaults', () => {
    expect(assigneeIdsForTypeChange(['mgr', 'usr'], [], profiles2)).toEqual([]);
  });

  it("keeps the ticket's Managers when the defaults hold none", () => {
    // Otherwise the write would be refused for lacking a Manager.
    expect(assigneeIdsForTypeChange(['mgr', 'usr'], ['usr2'], profiles2)).toEqual(['mgr', 'usr2']);
    expect(assigneeIdsForTypeChange(['mgr', 'mgr2'], ['usr2'], profiles2)).toEqual(['mgr', 'mgr2', 'usr2']);
  });

  it('is still invalid when neither side has a Manager, for the caller to refuse', () => {
    const ids = assigneeIdsForTypeChange(['usr'], ['usr2'], profiles2);
    expect(ids).toEqual(['usr2']);
    expect(assigneesAreValid(ids, profiles2)).toBe(false);
  });

  it('dedupes defaults', () => {
    expect(assigneeIdsForTypeChange([], ['mgr2', 'mgr2', ''], profiles2)).toEqual(['mgr2']);
  });
});
