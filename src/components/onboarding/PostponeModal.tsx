import { useState, useEffect } from 'react';
import { Modal } from '../Modal';
import { formatDateOnly } from '../../lib/dates';

interface Props {
  open: boolean;
  taskTitle: string;
  fromDate: string | null;
  /** Pre-filled with the date the user picked in the table. */
  initialDate: string | null;
  onCancel: () => void;
  onConfirm: (toDate: string | null, reason: string) => void;
}

/**
 * Pushing back an overdue task requires saying why. The reason is stored on the
 * task and shown on hover, and the new date takes the task out of the daily
 * overdue digest until it comes due again.
 */
export function PostponeModal({ open, taskTitle, fromDate, initialDate, onCancel, onConfirm }: Props) {
  const [date, setDate] = useState(initialDate ?? '');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setDate(initialDate ?? '');
      setReason('');
    }
  }, [open, initialDate]);

  const canSubmit = reason.trim().length > 0;

  return (
    <Modal open={open} onClose={onCancel} labelledBy="postpone-title" widthClass="max-w-md">
      <div className="px-6 py-5 border-b border-gray-200">
        <h3 id="postpone-title" className="text-lg font-serif font-semibold text-gray-900">Move Due Date</h3>
        <p className="mt-1 text-sm text-gray-500 line-clamp-2">{taskTitle}</p>
      </div>
      <div className="p-6 space-y-4">
        <p className="text-sm text-gray-600">
          This task was due {fromDate ? <strong>{formatDateOnly(fromDate)}</strong> : 'earlier'} and is overdue.
          Tell everyone why it's moving — the reason is saved on the task, and the overdue reminder pauses until the new date.
        </p>
        <div>
          <label htmlFor="postpone-date" className="block text-sm font-medium text-gray-700 mb-1">New due date</label>
          <input
            id="postpone-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
          />
        </div>
        <div>
          <label htmlFor="postpone-reason" className="block text-sm font-medium text-gray-700 mb-1">Reason <span className="text-red-500">*</span></label>
          <textarea
            id="postpone-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Waiting on the seller's title response"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
          />
        </div>
      </div>
      <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
        <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
        <button
          onClick={() => onConfirm(date || null, reason.trim())}
          disabled={!canSubmit}
          className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50 transition-colors"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
