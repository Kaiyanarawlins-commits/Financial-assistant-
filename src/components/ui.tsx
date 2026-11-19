import { useEffect, useRef, type ReactNode } from 'react';

/** Small shared primitives. Nothing here knows about finance. */

export function Card({
  title,
  action,
  flush,
  children,
}: {
  title?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`card${flush ? ' card--flush' : ''}`}>
      {(title || action) && (
        <div className="row row--between" style={{ padding: flush ? '16px 16px 10px' : undefined }}>
          {title && <h2 className="card__title" style={{ marginBottom: 0 }}>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="tiny faint">{hint}</span>}
    </label>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="switch">
      <div className="grow">
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        {hint && <div className="tiny faint" style={{ marginTop: 2 }}>{hint}</div>}
      </div>
      <button
        type="button"
        className="switch__track"
        role="switch"
        aria-checked={checked}
        aria-pressed={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="seg__btn"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Modal sheet. Traps nothing fancy, but does handle the two things that make a
 * modal feel broken when missing: Escape to close, and a locked background so
 * the page behind does not scroll away under the sheet.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={panelRef}>
        <div className="sheet__header">
          <h2 className="sheet__title">{title}</h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {children}
        {footer && <div style={{ marginTop: 18 }}>{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

/**
 * Renders the advisor's light markdown — **bold** and `- ` bullets — without
 * pulling in a markdown dependency for two constructs.
 */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, index) => {
        const bullet = /^\s*-\s+/.test(line);
        const body = bullet ? line.replace(/^\s*-\s+/, '') : line;
        const parts = body.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        const rendered = parts.map((part, i) =>
          part.startsWith('**') && part.endsWith('**') ? (
            <strong key={i}>{part.slice(2, -2)}</strong>
          ) : (
            <span key={i}>{part}</span>
          ),
        );
        if (line.trim() === '') return <div key={index} style={{ height: 8 }} />;
        return (
          <div key={index} style={bullet ? { display: 'flex', gap: 7 } : undefined}>
            {bullet && <span aria-hidden="true">•</span>}
            <span>{rendered}</span>
          </div>
        );
      })}
    </>
  );
}

// --- Icons ----------------------------------------------------------------
// Inline so the app has no icon-font or sprite dependency.

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path {...stroke} d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path {...stroke} d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CompassIcon({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="none" stroke="var(--accent)" strokeWidth="2" />
      <path d="M21.5 10.5l-3.2 7.8-7.8 3.2 3.2-7.8z" fill="var(--accent)" />
      <circle cx="16" cy="16" r="1.6" fill="var(--surface)" />
    </svg>
  );
}

export function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M3.5 10.5L12 4l8.5 6.5V20a1 1 0 01-1 1h-15a1 1 0 01-1-1z" />
      <path {...stroke} d="M9.5 21v-6h5v6" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}

export function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M3 7.5A2.5 2.5 0 015.5 5H18a1 1 0 011 1v2" />
      <rect {...stroke} x="3" y="8" width="18" height="11" rx="2.5" />
      <path {...stroke} d="M16.5 13.5h.01" />
    </svg>
  );
}

export function BriefcaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...stroke} x="2.8" y="7.5" width="18.4" height="12.5" rx="2.5" />
      <path {...stroke} d="M9 7.5V5.8A1.8 1.8 0 0110.8 4h2.4A1.8 1.8 0 0115 5.8v1.7" />
      <path {...stroke} d="M2.8 12.5h18.4M11 12.5v2h2v-2" />
    </svg>
  );
}

export function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle {...stroke} cx="12" cy="12" r="8.5" />
      <circle {...stroke} cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path {...stroke} d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle {...stroke} cx="12" cy="12" r="3.2" />
      <path
        {...stroke}
        d="M19.4 14.4a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5v.2a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H10a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V10a1.6 1.6 0 001.5 1h.2a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"
      />
    </svg>
  );
}

export function AlertIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path {...stroke} d="M12 9v4.5M12 17h.01" />
      <path {...stroke} d="M10.3 3.9L2.6 17.2A2 2 0 004.3 20.2h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path {...stroke} d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function InfoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle {...stroke} cx="12" cy="12" r="9" />
      <path {...stroke} d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="faint">
      <path {...stroke} d="M9.5 5.5L16 12l-6.5 6.5" />
    </svg>
  );
}
