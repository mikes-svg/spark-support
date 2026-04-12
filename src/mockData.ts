export type Role = 'admin' | 'user';
export type TicketStatus = 'Open' | 'In Progress' | 'On Hold' | 'Closed';
export type TicketPriority = 'Low' | 'Medium' | 'High' | 'Urgent';

export interface User {
  id: string;
  name: string;
  email: string;
  avatar: string;
  role: Role;
}

export interface Comment {
  id: string;
  ticketId: string;
  userId: string;
  body: string;
  timestamp: string;
  attachments?: string[];
}

export interface Ticket {
  id: string;
  type: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeId?: string;
  submitterId: string;
  createdAt: string;
  updatedAt: string;
}

export const users: User[] = [
{
  id: 'u1',
  name: 'Sarah Standifer',
  email: 'sarah@standifercapital.com',
  avatar: 'https://i.pravatar.cc/150?u=sarah',
  role: 'admin'
},
{
  id: 'u2',
  name: 'Michael Chen',
  email: 'michael@standifercapital.com',
  avatar: 'https://i.pravatar.cc/150?u=michael',
  role: 'admin'
},
{
  id: 'u3',
  name: 'Jessica Davis',
  email: 'jessica@standifercapital.com',
  avatar: 'https://i.pravatar.cc/150?u=jessica',
  role: 'user'
},
{
  id: 'u4',
  name: 'David Wilson',
  email: 'david@standifercapital.com',
  avatar: 'https://i.pravatar.cc/150?u=david',
  role: 'user'
},
{
  id: 'u5',
  name: 'Emily Brown',
  email: 'emily@standifercapital.com',
  avatar: 'https://i.pravatar.cc/150?u=emily',
  role: 'user'
}];


export const requestTypes = [
{ id: 'rt1', name: 'Maintenance', defaultAssigneeId: 'u2', active: true },
{ id: 'rt2', name: 'IT Support', defaultAssigneeId: 'u1', active: true },
{ id: 'rt3', name: 'Supplies', defaultAssigneeId: 'u2', active: true },
{ id: 'rt4', name: 'HR', defaultAssigneeId: 'u1', active: true },
{ id: 'rt5', name: 'Other', defaultAssigneeId: 'u1', active: true }];


export const tickets: Ticket[] = [
{
  id: 'TKT-1042',
  type: 'Maintenance',
  title: 'HVAC unit making loud noise in Suite 300',
  description:
  'The AC unit in the main conference room of Suite 300 is rattling loudly when it turns on. Needs inspection.',
  status: 'Open',
  priority: 'High',
  assigneeId: 'u2',
  submitterId: 'u3',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:00:00Z'
},
{
  id: 'TKT-1043',
  type: 'IT Support',
  title: 'Cannot access shared drive',
  description:
  'Getting an access denied error when trying to open the Q2 Financials folder on the Z drive.',
  status: 'In Progress',
  priority: 'Medium',
  assigneeId: 'u1',
  submitterId: 'u4',
  createdAt: '2026-04-02T10:30:00Z',
  updatedAt: '2026-04-02T11:15:00Z'
},
{
  id: 'TKT-1044',
  type: 'Supplies',
  title: 'Need more printer toner',
  description: 'The main office printer is low on black toner.',
  status: 'Closed',
  priority: 'Low',
  assigneeId: 'u2',
  submitterId: 'u5',
  createdAt: '2026-03-28T14:20:00Z',
  updatedAt: '2026-03-29T09:00:00Z'
},
{
  id: 'TKT-1045',
  type: 'HR',
  title: 'Update direct deposit info',
  description: 'Need to change my bank account for the next payroll cycle.',
  status: 'Closed',
  priority: 'Medium',
  assigneeId: 'u1',
  submitterId: 'u3',
  createdAt: '2026-03-15T08:00:00Z',
  updatedAt: '2026-03-16T10:00:00Z'
},
{
  id: 'TKT-1046',
  type: 'Maintenance',
  title: 'Leaky faucet in breakroom',
  description: 'The hot water handle is dripping constantly.',
  status: 'Open',
  priority: 'Low',
  assigneeId: 'u2',
  submitterId: 'u4',
  createdAt: '2026-04-03T07:45:00Z',
  updatedAt: '2026-04-03T07:45:00Z'
},
{
  id: 'TKT-1047',
  type: 'IT Support',
  title: 'New employee laptop setup',
  description:
  'Need a standard laptop setup for the new analyst starting next Monday.',
  status: 'In Progress',
  priority: 'High',
  assigneeId: 'u1',
  submitterId: 'u1',
  createdAt: '2026-04-02T16:00:00Z',
  updatedAt: '2026-04-03T09:30:00Z'
},
{
  id: 'TKT-1048',
  type: 'Other',
  title: 'Client gift basket delivery',
  description:
  'Need to arrange delivery of a gift basket to the Smith group.',
  status: 'Open',
  priority: 'Medium',
  assigneeId: undefined,
  submitterId: 'u5',
  createdAt: '2026-04-03T11:00:00Z',
  updatedAt: '2026-04-03T11:00:00Z'
}];


export const comments: Comment[] = [
{
  id: 'c1',
  ticketId: 'TKT-1043',
  userId: 'u1',
  body: 'I am looking into the permissions on that folder now.',
  timestamp: '2026-04-02T11:00:00Z'
},
{
  id: 'c2',
  ticketId: 'TKT-1043',
  userId: 'u4',
  body: 'Thanks, I need it for the 2pm meeting.',
  timestamp: '2026-04-02T11:05:00Z'
},
{
  id: 'c3',
  ticketId: 'TKT-1043',
  userId: 'u1',
  body: 'Permissions updated. Please try again.',
  timestamp: '2026-04-02T11:15:00Z'
},
{
  id: 'c4',
  ticketId: 'TKT-1042',
  userId: 'u2',
  body: 'Scheduled a vendor to come out tomorrow morning.',
  timestamp: '2026-04-01T10:00:00Z'
}];