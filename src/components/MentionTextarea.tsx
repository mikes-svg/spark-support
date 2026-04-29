import React, { useState, useRef, useEffect, useMemo } from 'react';

interface Profile { id: string; name: string; photoURL: string; }

interface Props {
  value: string;
  onChange: (text: string, mentionedIds: string[]) => void;
  users: Profile[];
  placeholder?: string;
  rows?: number;
  className?: string;
  onSubmit?: () => void;
}

interface Trigger {
  start: number;
  query: string;
}

function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const charBefore = at === 0 ? ' ' : before[at - 1];
  if (!/\s/.test(charBefore)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  if (query.length > 30) return null;
  return { start: at, query };
}

function extractMentionedIds(text: string, users: Profile[]): string[] {
  const ids = new Set<string>();
  const sorted = [...users].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
  for (const u of sorted) {
    if (!u.name) continue;
    const escaped = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)@${escaped}(?=\\s|$|[.,!?;:])`, 'g');
    if (re.test(text)) ids.add(u.id);
  }
  return [...ids];
}

export function MentionTextarea({
  value,
  onChange,
  users,
  placeholder,
  rows = 2,
  className = '',
  onSubmit,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return users
      .filter((u) => u.name?.toLowerCase().includes(q))
      .slice(0, 6);
  }, [trigger, users]);

  useEffect(() => {
    setActiveIdx(0);
  }, [trigger?.query]);

  const update = (text: string) => {
    onChange(text, extractMentionedIds(text, users));
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    const caret = e.target.selectionStart ?? text.length;
    update(text);
    setTrigger(findTrigger(text, caret));
  };

  const handleSelectionChange = () => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    setTrigger(findTrigger(el.value, caret));
  };

  const insertMention = (user: Profile) => {
    if (!trigger) return;
    const el = ref.current;
    if (!el) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.start + 1 + trigger.query.length);
    const insertion = `@${user.name} `;
    const next = before + insertion + after;
    update(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(matches[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative flex-1">
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={handleSelectionChange}
        onKeyUp={handleSelectionChange}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
      {trigger && matches.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-64 bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden z-30">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-400 border-b border-gray-100 bg-gray-50">
            Mention a person
          </div>
          <div className="max-h-56 overflow-y-auto">
            {matches.map((u, idx) => (
              <button
                key={u.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(u);
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left ${
                  idx === activeIdx ? 'bg-brand-dark/5' : 'hover:bg-gray-50'
                }`}
              >
                <img src={u.photoURL} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
                <span className="text-sm text-gray-900 truncate">{u.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function renderCommentBody(body: string, mentionedIds: string[], users: Record<string, Profile>): React.ReactNode {
  if (!mentionedIds || mentionedIds.length === 0) return body;
  const names = mentionedIds
    .map((id) => users[id]?.name)
    .filter((n): n is string => Boolean(n))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return body;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|\\s)(@(?:${escaped.join('|')}))(?=\\s|$|[.,!?;:])`, 'g');
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const matchStart = m.index + m[1].length;
    if (matchStart > last) parts.push(body.slice(last, matchStart));
    parts.push(
      <span key={key++} className="font-medium bg-brand-gold/20 text-brand-dark rounded px-1">
        {m[2]}
      </span>,
    );
    last = matchStart + m[2].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}
