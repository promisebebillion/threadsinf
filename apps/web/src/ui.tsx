import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { SocialAccount, PostStatus } from "@threadflow/shared";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { messageOf } from "./api";
import { postStatusLabel } from "./publication-status";

export function Button({
  children,
  variant = "primary",
  loading,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`button button-${variant} ${className}`}
    >
      {loading && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}

export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <div className={`wordmark ${light ? "light" : ""}`}>
      <span className="brand-symbol">
        <i />
        <i />
        <i />
      </span>
      <span>
        threadflow<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

export function Avatar({
  account,
  size = "normal",
}: {
  account: Pick<SocialAccount, "username" | "displayName" | "avatarUrl">;
  size?: "small" | "normal" | "large";
}) {
  const [failed, setFailed] = useState(false);
  const colors = ["sage", "violet", "peach", "sky", "rose"];
  const color =
    colors[
      [...account.username].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
        colors.length
    ];
  const safeUrl =
    account.avatarUrl && /^https?:\/\//i.test(account.avatarUrl)
      ? account.avatarUrl
      : null;
  return (
    <span
      className={`avatar avatar-${size} avatar-${color}`}
      aria-label={account.displayName}
    >
      {safeUrl && !failed ? (
        <img
          src={safeUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        account.displayName
          .split(" ")
          .map((part) => part.charAt(0))
          .slice(0, 2)
          .join("")
          .toUpperCase()
      )}
    </span>
  );
}

export function AccountStack({
  accounts,
  limit = 3,
}: {
  accounts: SocialAccount[];
  limit?: number;
}) {
  return (
    <span className="account-stack">
      {accounts.slice(0, limit).map((account) => (
        <Avatar key={account.id} account={account} size="small" />
      ))}
      {accounts.length > limit && (
        <span className="avatar avatar-small avatar-more">
          +{accounts.length - limit}
        </span>
      )}
    </span>
  );
}

export function StatusBadge({
  status,
}: {
  status: PostStatus | SocialAccount["status"];
}) {
  const label = postStatusLabel(status);
  return (
    <span className={`status status-${status}`}>
      <span
        className={status === "publishing" ? "status-dot pulse" : "status-dot"}
      />
      {label}
    </span>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog ${wide ? "dialog-wide" : ""}`}>
          <header className="dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? (
                <Dialog.Description>{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  {title}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="Close dialog">
                <X size={20} />
              </button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
    >
      <div className="confirm-actions">
        <Button
          variant="secondary"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          Keep it
        </Button>
        <Button variant="danger" loading={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = <MessageCircle size={25} />,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={22} />
      <div>
        <h3>We couldn’t load this</h3>
        <p>{messageOf(error)}</p>
      </div>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          <RefreshCw size={15} />
          Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div aria-label="Loading" aria-busy="true" className="loading-rows">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton skeleton-avatar" />
          <div>
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line short" />
          </div>
          <span className="skeleton skeleton-pill" />
        </div>
      ))}
    </div>
  );
}

export function PageHeading({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="heading-context">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Checkmark({ checked }: { checked: boolean }) {
  return (
    <span className={`checkbox-mark ${checked ? "checked" : ""}`}>
      {checked && <Check size={13} strokeWidth={3} />}
    </span>
  );
}
export function SmallLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="text-link">
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}

export function useMobile() {
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}
