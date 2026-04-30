import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getDoc, doc, setDoc, addDoc, runTransaction, collection, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { db, storage } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { UploadCloud, X } from 'lucide-react';
import { getOrSeedRequestTypes } from '../lib/seedRequestTypes';
import { getDefaultAssigneeIds } from '../types';
import { logTicketCreated } from '../lib/ticketEvents';

interface RequestType {
  id: string;
  name: string;
  defaultAssigneeIds?: string[];
  defaultAssigneeId?: string | null;
  active: boolean;
}

export function SubmitRequestPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getOrSeedRequestTypes()
      .then((types) => setRequestTypes((types as RequestType[]).filter((t) => t.active)))
      .catch((err) => console.error('Failed to fetch request types:', err));
  }, []);

  const addFiles = (newFiles: FileList | File[]) => {
    setFiles((prev) => [...prev, ...Array.from(newFiles)]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !db) return;
    setIsSubmitting(true);

    const form = e.currentTarget;
    const data = new FormData(form);
    const type = data.get('type') as string;
    const priority = data.get('priority') as string;
    const title = data.get('title') as string;
    const description = data.get('description') as string;

    const selectedType = requestTypes.find((rt) => rt.name === type);
    const assigneeIds = selectedType ? getDefaultAssigneeIds(selectedType) : [];

    try {
      const counterRef = doc(db, 'meta', 'ticketCounter');
      const ticketId = await runTransaction(db, async (tx) => {
        const counterDoc = await tx.get(counterRef);
        const count = (counterDoc.data()?.count ?? 1048) + 1;
        tx.set(counterRef, { count }, { merge: true });
        return `TKT-${String(count).padStart(4, '0')}`;
      });

      const participants = [...new Set([user.id, ...assigneeIds])];

      await setDoc(doc(db, 'tickets', ticketId), {
        type, title, description, status: 'Open', priority,
        assigneeIds, submitterId: user.id, participants,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });

      await logTicketCreated(ticketId, user.id);

      if (storage) {
        for (const file of files) {
          const fileRef = ref(storage, `attachments/${ticketId}/${file.name}`);
          await uploadBytes(fileRef, file);
        }
      }

      // Email submitter confirmation
      await addDoc(collection(db, 'mail'), {
        to: user.email,
        message: {
          subject: `Your request ${ticketId} has been submitted`,
          html: `<p>Your support request has been submitted successfully.</p><p><strong>${ticketId}</strong> — ${title}</p><p>Priority: ${priority} · Type: ${type}</p><p><a href="${window.location.origin}/tickets/${ticketId}">View ticket →</a></p>`,
        },
      });

      // Email each assignee
      for (const assigneeId of assigneeIds) {
        const assigneeDoc = await getDoc(doc(db, 'profiles', assigneeId));
        const assigneeEmail = assigneeDoc.data()?.email;
        if (assigneeEmail) {
          await addDoc(collection(db, 'mail'), {
            to: assigneeEmail,
            message: {
              subject: `New ${priority} ticket: ${title}`,
              html: `<p>A new support request has been assigned to you.</p><p><strong>${ticketId}</strong> — ${title}</p><p><a href="${window.location.origin}/tickets/${ticketId}">View ticket →</a></p>`,
            },
          });
        }
      }

      navigate('/');
    } catch (err) {
      console.error('Failed to submit ticket:', err);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50">
          <h2 className="text-xl font-serif font-semibold text-gray-900">Submit New Request</h2>
          <p className="mt-1 text-sm text-gray-500">Please provide details about your request so we can route it correctly.</p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label htmlFor="type" className="block text-sm font-medium text-gray-700">Request Type</label>
              <select id="type" name="type" required className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark sm:text-sm rounded-md border">
                <option value="">Select a type…</option>
                {requestTypes.map((rt) => <option key={rt.id} value={rt.name}>{rt.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="priority" className="block text-sm font-medium text-gray-700">Priority</label>
              <select id="priority" name="priority" required className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark sm:text-sm rounded-md border">
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700">Title</label>
            <input type="text" name="title" id="title" required placeholder="Brief summary of the issue" className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2" />
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
            <textarea id="description" name="description" rows={5} required placeholder="Provide as much detail as possible…" className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2" />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-700 mb-2">Attachments</span>
            <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md hover:bg-gray-50 transition-colors cursor-pointer" onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop} onClick={() => fileInputRef.current?.click()}>
              <div className="space-y-1 text-center">
                <UploadCloud className="mx-auto h-12 w-12 text-gray-400" />
                <div className="flex text-sm text-gray-600 justify-center">
                  <span className="relative cursor-pointer bg-white rounded-md font-medium text-brand-dark hover:text-brand-gold">Upload files</span>
                  <p className="pl-1">or drag and drop</p>
                </div>
                <p className="text-xs text-gray-500">PNG, JPG, PDF up to 10MB</p>
              </div>
            </div>
            <input ref={fileInputRef} type="file" className="hidden" multiple onChange={(e) => { if (e.target.files && e.target.files.length > 0) { const picked = Array.from(e.target.files); setFiles((prev) => [...prev, ...picked]); } e.target.value = ''; }} />
            {files.length > 0 && (
              <ul className="mt-3 space-y-1">
                {files.map((file, idx) => (
                  <li key={idx} className="text-sm text-gray-600 flex items-center justify-between group">
                    <span className="flex items-center">
                      <span className="w-2 h-2 bg-brand-gold rounded-full mr-2" />{file.name}
                    </span>
                    <button type="button" onClick={() => removeFile(idx)} className="text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-4 flex items-center justify-end gap-4 border-t border-gray-200">
            <Link to="/" className="text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</Link>
            <button type="submit" disabled={isSubmitting} className="inline-flex justify-center py-2 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-brand-dark hover:bg-[#153427] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-dark disabled:opacity-50 transition-colors">
              {isSubmitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
