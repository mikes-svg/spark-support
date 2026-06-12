/** Full-page centered loading spinner used while a page's data loads. */
export function PageSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" />
    </div>
  );
}
