export interface SidePanelProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** Right-hand panel chrome. Hosts settings or the file view, one at a time. */
export function SidePanel({ title, subtitle, onClose, children }: SidePanelProps): React.JSX.Element {
  return (
    <aside className="side-panel">
      <div className="pane-header">
        <span className="panel-title" title={subtitle ?? title}>
          {title}
        </span>
        <button type="button" className="icon" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </aside>
  );
}
