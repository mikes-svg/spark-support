import { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; }

/** Catches render-time errors anywhere in the tree and shows a recoverable
 *  fallback instead of a blank white screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-brand-cream flex flex-col items-center justify-center px-6 text-center">
          <h1 className="text-xl font-serif font-semibold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-600 mb-6 max-w-md">
            An unexpected error occurred. Reloading the page usually fixes it.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#153427] transition-colors"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
