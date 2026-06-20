import { useState, useEffect } from 'react';

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  /** Pass sizing/shape here, e.g. "w-8 h-8 rounded-full". */
  className?: string;
}

/**
 * Round avatar image that falls back to the person's initials if the photo URL
 * is missing or fails to load (e.g. a stale Google photo 404s), so a broken
 * image never shows.
 */
export function Avatar({ src, name, className = '' }: AvatarProps) {
  const [errored, setErrored] = useState(false);
  // A new src (e.g. list row reused for a different person) should retry.
  useEffect(() => { setErrored(false); }, [src]);

  if (!src || errored) {
    const initials =
      (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
    return (
      <span
        aria-hidden="true"
        title={name || undefined}
        className={`inline-flex items-center justify-center bg-brand-dark text-brand-gold text-[10px] font-semibold leading-none overflow-hidden ${className}`}
      >
        {initials}
      </span>
    );
  }
  return <img src={src} alt="" title={name || undefined} onError={() => setErrored(true)} className={className} />;
}
