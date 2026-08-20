import React from 'react';

// The app's one crash net (decided, new).
//
// Before this there was no error boundary anywhere in the client, so **any**
// component throwing during render or during React's commit phase tore down
// the whole tree and left an empty `#root` — a white screen mid-fight, with
// no way back except a manual reload and no clue what happened. That is
// exactly how the Roll Requester bug presented (a Promise handed to React as
// an effect cleanup, thrown from `safelyCallDestroy`): a two-line defect that
// took the entire table's app with it.
//
// Deliberately at the very top, wrapping the router rather than each page:
// the failure mode this exists for is "something nobody predicted threw", and
// per-page boundaries only catch the pages somebody remembered to wrap.
// Reload is the only offered action on purpose — all real state lives on the
// server and arrives over the socket, so a reload genuinely recovers the
// session rather than losing work.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept on the console rather than swallowed: the stack is the only record
    // of what happened, and this app has no error reporting behind it.
    console.error('Unhandled render error', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 p-6 text-center">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wide text-brand-400">
          Something broke
        </h1>
        <p className="max-w-md text-sm text-zinc-400">
          The page hit an error it couldn&apos;t recover from. Nothing is lost — the fight lives on
          the server, so reloading picks it back up exactly where it was.
        </p>
        <pre className="max-w-full overflow-x-auto panel-cut-sm border border-zinc-800 bg-zinc-900 p-3 text-left text-xs text-zinc-500">
          {String(this.state.error?.message ?? this.state.error)}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-11 panel-cut-sm bg-brand-600 px-6 py-2 font-display font-semibold uppercase tracking-wide text-white hover:bg-brand-500"
        >
          Reload
        </button>
      </div>
    );
  }
}
