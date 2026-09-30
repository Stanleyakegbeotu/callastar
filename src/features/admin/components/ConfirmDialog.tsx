import { useEffect, useRef, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button, for anything that destroys or invalidates something. */
  destructive?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * One confirmation dialog for the whole dashboard.
 *
 * Built on the native `<dialog>` element, which brings focus trapping, the
 * backdrop, Escape-to-close and correct semantics without reimplementing any
 * of it.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // Escape and the backdrop both route through the same cancel path.
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (!busy) onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [busy, onCancel]);

  return (
    <dialog className="admin-dialog" ref={ref} aria-labelledby="admin-dialog-title">
      <div className="admin-dialog-body">
        <h2 id="admin-dialog-title">{title}</h2>
        <div className="admin-dialog-content">{children}</div>
        <div className="admin-dialog-actions">
          <button type="button" className="admin-button admin-button-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`admin-button ${destructive ? "admin-button-danger" : "admin-button-primary"}`}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export default ConfirmDialog;
