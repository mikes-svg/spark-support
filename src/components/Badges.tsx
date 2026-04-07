import React from 'react';
import { TicketStatus, TicketPriority } from '../mockData';
export function StatusBadge({ status }: {status: TicketStatus;}) {
  const colors = {
    Open: 'bg-blue-100 text-blue-800 border-blue-200',
    'In Progress': 'bg-amber-100 text-amber-800 border-amber-200',
    Resolved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    Closed: 'bg-gray-100 text-gray-800 border-gray-200'
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[status]}`}>
      
      {status}
    </span>);

}
export function PriorityBadge({ priority }: {priority: TicketPriority;}) {
  const colors = {
    Low: 'bg-gray-100 text-gray-800',
    Medium: 'bg-blue-100 text-blue-800',
    High: 'bg-amber-100 text-amber-800',
    Urgent: 'bg-red-100 text-red-800'
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[priority]}`}>
      
      {priority}
    </span>);

}