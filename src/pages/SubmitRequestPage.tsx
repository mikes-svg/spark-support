import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  collection,
  getDocs,
  doc,
  setDoc,
  runTransaction,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { db, storage } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { UploadCloud } from 'lucide-react';

interface RequestType {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  active: boolean;
}

export function SubmitRequestPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);

  useEffect(() => {
    getDocs(
      query(collection(db, 'requestTypes'), where('active', '==', true), orderBy('name'))
    ).then((snap) => {
      setRequestTypes(snap.docs.map((d) => ({ id: d.id, ...d.data() } as RequestType)));
    });
  }, []);

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) setFiles(Array.from(e.dataTransfer.files));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    setIsSubmitting(true);

    const form = e.currentTarget;
    const data = new FormData(form);
    const type = data.get('type') as string;
    const priority = data.get('priority') as string;
    const title = data.get('title') as string;
    const description = data.get('description') as string;

    const selectedType = requestTypes.find((rt) => rt.name === type);
    const assigneeId = selectedType?.defaultAssigneeId || null;

    try {
      // Generate sequential ticket ID
      const counterRef = doc(db, 'meta', 'ticketCounter');
      const ticketId = await runTransaction(db, async (tx) => {
        const counterDoc = await tx.get(counterRef);
        const count = (counterDoc.data()?.count ?? 1048) + 1;
        tx.set(counterRef, { count }, { merge: true });
        return `TKT-${String(count).padStart(4, '0')}`;
      });

      const participants = [user.id, assigneeId].filter(Boolean) as string[];

      await setDoc(doc(db, 'tickets', ticketId), {
        type,
        title,
        description,
        status: 'Open',
        priority,
        assigneeId,
        submitterId: user.id,
        participants,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Upload attachments
      for (const file of files) {
        const fileRef = ref(storage, `attachments/${ticketId}/${file.name}`);
        await uploadBytes(fileRef, file);
      }

      // Queue notification email
      if (assigneeId) {
        await setDoc(doc(collection(db, 'mail')), {
          to: assigneeId, // resolved to email by Cloud Function
          ticketId,
          type: 'new_ticket',
          createdAt: serverTimestamp(),
        });
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
          <p className="mt-1 text-sm text-gray-500">
            Please provide details about your request so we can route it correctly.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label htmlFor="type" className="block text-sm font-medium text-gray-700">
                Request Type
              </label>
              <select
                id="type"
                name="type"
                required
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark sm:text-sm rounded-md border"
              >
                <option value="">Select a type…</option>
                {requestTypes.map((rt) => (
                  <option key={rt.id} value={rt.name}>{rt.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="priority" className="block text-sm font-medium text-gray-700">
                Priority
              </label>
              <select
                id="priority"
                name="priority"
                required
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark sm:text-sm rounded-md border"
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700">
              Title
            </label>
            <input
              type="text"
              name="title"
              id="title"
              required
              placeholder="Brief summary of the issue"
              className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2"
            />
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              rows={5}
              required
              placeholder="Provide as much detail as possible…"
              className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Attachments</label>
            <div
              className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md hover:bg-gray-50 transition-colors cursor-pointer"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              onClick={() => document.getElementById('file-upload')?.click()}
            >
              <div className="space-y-1 text-center">
                <UploadCloud className="mx-auto h-12 w-12 text-gray-400" />
                <div className="flex text-sm text-gray-600 justify-center">
                  <label htmlFor="file-upload" className="relative cursor-pointer bg-white rounded-md font-medium text-brand-dark hover:text-brand-gold">
                    <span>Upload a file</span>
                    <input
                      id="file-upload"
                      name="file-upload"
                      type="file"
                      className="sr-only"
                      multiple
                      onChange={(e) => { if (e.target.files) setFiles(Array.from(e.target.files)); }}
                    />
                  </label>
                  <p className="pl-1">or drag and drop</p>
                </div>
                <p className="text-xs text-gray-500">PNG, JPG, PDF up to 10MB</p>
              </div>
            </div>
            {files.length > 0 && (
              <ul className="mt-3 space-y-1">
                {files.map((file, idx) => (
                  <li key={idx} className="text-sm text-gray-600 flex items-center">
                    <span className="w-2 h-2 bg-brand-gold rounded-full mr-2" />
                    {file.name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-4 flex items-center justify-end gap-4 border-t border-gray-200">
            <Link to="/" className="text-sm font-medium text-gray-700 hover:text-gray-900">
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex justify-center py-2 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-brand-dark hover:bg-[#153427] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-dark disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
