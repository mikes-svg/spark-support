// STUB — replaced by the Sharing lane. The exported ShareTarget type and the
// component props are the pinned contract the Notebook panel builds against.
import type {
  OnboardingNotebook,
  OnboardingNotebookPage,
  NotebookShareLevel,
  Profile,
} from '../../types';

/** What is being shared: the whole notebook, or one page within it. */
export type ShareTarget =
  | { kind: 'notebook'; notebook: OnboardingNotebook }
  | { kind: 'page'; notebook: OnboardingNotebook; page: OnboardingNotebookPage };

export interface ShareNotebookDialogProps {
  open: boolean;
  /** Null when closed. Carries the notebook/page whose share arrays hold the
   *  current levels (read them with shareLevelOf from lib/notebooks). */
  target: ShareTarget | null;
  /** People the notebook may be shared with (onboarding users). */
  people: Profile[];
  /** Persist a level change for one user; the parent writes it and refreshes. */
  onShare: (userId: string, level: NotebookShareLevel) => Promise<void>;
  onClose: () => void;
}

export function ShareNotebookDialog(_props: ShareNotebookDialogProps) {
  return null;
}
