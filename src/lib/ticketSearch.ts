import { getAssigneeIds } from '../types';
import type { Ticket, Profile } from '../types';

/**
 * Free-text ticket search, shared by My Tickets and All Tickets so the two
 * behave identically — the same fields match, the same way, on both pages.
 *
 * Firestore has no full-text index, so matching happens in memory. That is only
 * honest if the caller has actually loaded everything it claims to be searching:
 * My Tickets already loads the signed-in user's full history, and All Tickets
 * calls its own "load everything" path before using this (see SEARCH_FETCH_MAX
 * there). A page that searches one loaded page while implying otherwise is the
 * bug this module exists to stop repeating.
 */

/** Fields a search term is matched against, in the order a reader would expect. */
export type TicketSearchField = 'id' | 'title' | 'description' | 'type' | 'person';

export interface TicketMatcher {
  /** True when the term is empty — callers can skip filtering entirely. */
  isEmpty: boolean;
  /** The normalized term, for display ("No results for …"). */
  term: string;
  matches: (ticket: Ticket) => boolean;
}

/** Lowercased and trimmed; everything here compares in this form. */
export function normalizeSearch(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Build a matcher over ticket id, title, description, type, and the names of
 * the submitter and assignees.
 *
 * Names are resolved through `profiles`, so a caller that has only loaded some
 * profiles will silently fail to match people it hasn't seen. Both pages load
 * the whole directory (a dozen docs) rather than per-page profiles, which keeps
 * "search by assignee name" working across every ticket.
 */
export function makeTicketMatcher(
  rawSearch: string,
  profiles: Record<string, Profile>,
): TicketMatcher {
  const term = normalizeSearch(rawSearch);
  if (!term) {
    return { isEmpty: true, term, matches: () => true };
  }
  return {
    isEmpty: false,
    term,
    matches: (ticket: Ticket) => {
      const names = [ticket.submitterId, ...getAssigneeIds(ticket)]
        .map((id) => (id ? profiles[id]?.name ?? '' : ''));
      return [ticket.id, ticket.title, ticket.description ?? '', ticket.type, ...names]
        .some((field) => field.toLowerCase().includes(term));
    },
  };
}
