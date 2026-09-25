#!/usr/bin/env bash
#
# Delete ALL task-feature data from a Firebase project.
#
# Written for the UAT period: Chloe and Greg test against production, then this
# removes everything they created. Only the task collections are touched —
# tickets, onboarding, profiles, notebooks, requestTypes and mail are never
# named here and cannot be reached by this script.
#
#   ./scripts/cleanup-test-tasks.sh              # dry run: show what exists
#   ./scripts/cleanup-test-tasks.sh --confirm    # actually delete
#
set -euo pipefail

PROJECT="${PROJECT:-spark-support-28ed9}"
CONFIRM="${1:-}"

# Every collection the task feature owns. Nothing else may be added here.
COLLECTIONS=(
  tasks
  taskSpaces
  taskLists
  taskStatusSets
  taskTags
  taskTemplates
  taskSeries
  taskComments
  taskEvents
  gcalConnections
  gcalChannels
)

echo
echo "Project: $PROJECT"
echo

if [ "$CONFIRM" != "--confirm" ]; then
  echo "DRY RUN — nothing will be deleted."
  echo
  echo "These collections would be deleted recursively:"
  for c in "${COLLECTIONS[@]}"; do echo "  - $c"; done
  echo
  echo "NOT touched: tickets, comments, ticketEvents, profiles, requestTypes,"
  echo "             onboarding*, mail, meta"
  echo
  echo "Storage objects under taskAttachments/ are NOT removed by this script."
  echo "After the Firestore delete, remove them with:"
  echo "  gsutil -m rm -r gs://${PROJECT}.appspot.com/taskAttachments"
  echo
  echo "Re-run with --confirm to delete."
  exit 0
fi

echo "DELETING. This cannot be undone."
echo
for c in "${COLLECTIONS[@]}"; do
  echo "--- $c"
  npx firebase firestore:delete "$c" --recursive --force --project "$PROJECT"
done

echo
echo "Firestore task collections deleted."
echo
echo "Storage is separate. To remove uploaded attachments:"
echo "  gsutil -m rm -r gs://${PROJECT}.appspot.com/taskAttachments"
echo
echo "Note: tasks/{id}/attachments metadata docs went with the recursive"
echo "delete above, so any Storage objects left are now unreferenced."
