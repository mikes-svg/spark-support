import { describe, expect, it } from 'vitest';
import { assigneesAreValid, lockedAssigneeIds } from './ticketAssignees';
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

  it('is waived once a department is accountable for the ticket', () => {
    // A User in the department must be able to pick the ticket up as its only
    // assignee — the department, not a named Manager, is the accountable party.
    expect(lockedAssigneeIds(['mgr', 'usr'], profiles, true)).toEqual([]);
    expect(assigneesAreValid(['usr'], profiles, true)).toBe(true);
  });
});

describe('ticketParticipants', () => {
  it('is submitter + assignees + department members, deduped', () => {
    expect(ticketParticipants({ submitterId: 'sub', status: 'Open' }, ['mgr', 'usr'], ['usr', 'dep']))
      .toEqual(['sub', 'mgr', 'usr', 'dep']);
  });

  it('keeps everyone but the submitter off a Scheduled ticket until it goes live', () => {
    expect(ticketParticipants({ submitterId: 'sub', status: 'Scheduled' }, ['mgr'], ['dep'])).toEqual(['sub']);
  });

  it('drops empty ids rather than writing them into the array', () => {
    expect(ticketParticipants({ submitterId: 'sub' }, ['', 'mgr'], [])).toEqual(['sub', 'mgr']);
  });
});
