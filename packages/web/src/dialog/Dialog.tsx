import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.js';

/**
 * The shell every dialog in the app sits in.
 *
 * A native `<dialog>` rather than a div with a high z-index. It brings the
 * backdrop, the focus trap, the inertness of everything behind it, Escape,
 * and returning focus to whatever opened it - all of which we would otherwise
 * be writing and getting subtly wrong. The panel stays visible behind it on
 * purpose, so the node you acted on is still there to see.
 */
export function Dialog({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const closeDialog = useStore((s) => s.closeDialog);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();

    /*
     * showModal() does the focusing itself, and it would take the header's
     * close button - the first focusable thing in the card. React's autoFocus
     * prop is no help: it calls focus() during mount, before this effect runs,
     * so showModal simply overrides it. Hence one mechanism, here, aiming at
     * the first control of the body rather than of the card.
     */
    el.querySelector<HTMLElement>(
      '.dialog-body input:not(:disabled), .dialog-body select:not(:disabled),' +
        ' .dialog-body textarea:not(:disabled)',
    )?.focus();

    // Closing it rather than only unmounting it is what returns focus to
    // whatever opened it; the browser does that as part of close(), and
    // dropping the element from the DOM on its own does not.
    return () => {
      if (el.open) el.close();
    };
  }, []);

  // Escape and the backdrop both go through the element's own `close` event,
  // so the store learns about every way out through one path.
  return (
    <dialog
      className="dialog"
      ref={ref}
      onClose={closeDialog}
      onClick={(e) => {
        // The element fills the viewport once it is modal; only a click that
        // lands on it rather than on the card inside is a backdrop click.
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="dialog-card">
        <header className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <span className="spacer" />
          <button
            className="btn"
            type="button"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/**
 * The body of a dialog that submits something to the hub.
 *
 * A real `<form>`, so Enter submits from any single-line field without a
 * keydown handler per input. Everything about waiting and failing lives here
 * rather than in each dialog: the submit disables itself while in flight, and
 * a refusal is shown *in* the dialog, which stays open with what was typed
 * still in it. That is the whole reason these moved out of the tree.
 */
export function DialogForm({
  submitLabel,
  cancelLabel = 'cancel',
  canSubmit = true,
  danger = false,
  secondary,
  onSubmit,
  children,
}: {
  submitLabel: string;
  /**
   * What dismissing the dialog is called.
   *
   * Worth overriding wherever closing is not the same as saying no. On a
   * dialog asking about an agent's proposal it means "leave it waiting", and
   * a button called "cancel" was read as a refusal - which left the agent
   * blocked on an answer nobody had given.
   */
  cancelLabel?: string;
  canSubmit?: boolean;
  danger?: boolean;
  /**
   * A third answer, for a dialog where cancel is not a decision.
   *
   * Reviewing an agent's proposal is the case: accepting and declining are
   * both answers somebody is waiting on, and closing the dialog is neither -
   * it leaves the question open.
   */
  secondary?: { label: string; onClick: () => Promise<void> };
  onSubmit: () => Promise<void>;
  children: React.ReactNode;
}) {
  const closeDialog = useStore((s) => s.closeDialog);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A dialog can be dismissed while its request is in flight, and resolving
  // into an unmounted component is a warning and a leak.
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy || !canSubmit) return;
      setBusy(true);
      setError(null);
      try {
        await onSubmit();
        if (alive.current) closeDialog();
      } catch (err) {
        if (alive.current) {
          setError((err as Error).message);
          setBusy(false);
        }
      }
    },
    [busy, canSubmit, onSubmit, closeDialog],
  );

  return (
    <form className="dialog-body" onSubmit={submit}>
      {children}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <footer className="dialog-actions">
        <button className="btn" type="button" onClick={closeDialog}>
          {cancelLabel}
        </button>
        {secondary && (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              secondary.onClick().then(
                () => alive.current && closeDialog(),
                (err: Error) => {
                  if (!alive.current) return;
                  setError(err.message);
                  setBusy(false);
                },
              );
            }}
          >
            {secondary.label}
          </button>
        )}
        <button
          className={`btn ${danger ? 'danger-solid' : 'primary'}`}
          type="submit"
          disabled={busy || !canSubmit}
        >
          {busy ? 'working…' : submitLabel}
        </button>
      </footer>
    </form>
  );
}

/** One labelled field. The hint sits under it, where a refusal also lands. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="dialog-field">
      <span className="dialog-label">{label}</span>
      {children}
      {hint && <span className="dialog-hint">{hint}</span>}
    </label>
  );
}
