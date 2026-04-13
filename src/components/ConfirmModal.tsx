import React from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-6">
          <h3 className="text-lg font-serif font-semibold text-gray-900 mb-2">{title}</h3>
          <p className="text-sm text-gray-600">{message}</p>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-5 py-2 text-sm font-medium rounded-lg text-white transition-colors ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-dark hover:bg-[#153427]'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
