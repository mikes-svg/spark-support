import { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { Bell, Check } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

/**
 * Per-person control over how much mail the portal sends.
 *
 * The server side already existed — `wantsImmediate()` in
 * functions/taskNotifications.js has always read `notificationPrefs` off the
 * profile — but nothing let anyone set it, so in practice everybody was on
 * `immediate` with no way off. This page is only the missing control.
 *
 * It writes one field on the signed-in user's own profile, which the profiles
 * rule already permits (a user may edit their own non-role fields).
 */

type Pref = 'immediate' | 'mentions-only' | 'digest-only';

const OPTIONS: { value: Pref; label: string; detail: string }[] = [
  {
    value: 'immediate',
    label: 'Everything, as it happens',
    detail: 'Email me when a task is assigned to me, when its status or due date changes, and for every comment on tasks I am on.',
  },
  {
    value: 'mentions-only',
    label: 'Only when I am mentioned',
    detail: 'Email me when someone @mentions me in a comment. Everything else waits for the morning brief.',
  },
  {
    value: 'digest-only',
    label: 'Nothing immediate',
    detail: 'No mail during the day at all. Everything arrives in one morning brief at 7am.',
  },
];

export function NotificationSettingsPage() {
  const { user } = useAuth();
  const [pref, setPref] = useState<Pref>(
    (user?.notificationPrefs as Pref | undefined) ?? 'immediate',
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const choose = async (next: Pref) => {
    if (!db || !user || saving || next === pref) return;
    const previous = pref;
    // Optimistic: the radio moves immediately and rolls back on failure, so the
    // control never sits in a state the server disagrees with.
    setPref(next);
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await updateDoc(doc(db, 'profiles', user.id), { notificationPrefs: next });
      setSaved(true);
    } catch (err) {
      console.error('Failed to save notification preference:', err);
      setPref(previous);
      setError('Could not save that. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Bell className="w-5 h-5 text-brand-dark" />
        <div>
          <h2 className="text-lg font-serif text-brand-dark">Notifications</h2>
          <p className="text-sm text-gray-500">How much the portal emails you about tasks.</p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-4 py-3" role="alert">
          {error}
        </p>
      )}

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 divide-y divide-gray-200">
        {OPTIONS.map((opt) => {
          const active = pref === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => choose(opt.value)}
              disabled={saving}
              aria-pressed={active}
              className={`w-full text-left px-6 py-4 flex gap-4 items-start transition-colors min-h-[44px] disabled:opacity-60 ${
                active ? 'bg-brand-dark/5' : 'hover:bg-gray-50'
              }`}
            >
              <span
                className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                  active ? 'bg-brand-dark border-brand-dark' : 'border-gray-300'
                }`}
              >
                {active && <Check className="w-2.5 h-2.5 text-white" />}
              </span>
              <span>
                <span className="block text-sm font-medium text-brand-dark">{opt.label}</span>
                <span className="block text-sm text-gray-500 mt-0.5">{opt.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      {saved && !saving && (
        <p className="text-sm text-emerald-700">Saved. This takes effect on the next notification.</p>
      )}

      <p className="text-xs text-gray-500">
        The 7am morning brief is sent to everyone regardless of this setting — it is the one email
        this cannot switch off, because it is how overdue work gets noticed.
      </p>
    </div>
  );
}
