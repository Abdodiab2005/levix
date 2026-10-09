// file: frontend/src/components/ui/menu.tsx
import { Check, MoreVertical } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../utils/cn";
import { IconButton } from "./button";
import { Popover } from "./popover";

const MenuCloseContext = createContext<() => void>(() => {});

export interface MenuProps {
  trigger: ReactElement;
  label: string;
  align?: "start" | "end" | "center";
  children: ReactNode;
}

/** Anchored menu. Items call the close context so the panel dismisses on select. */
export function Menu({ trigger, label, align = "end", children }: MenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <MenuCloseContext.Provider value={() => setOpen(false)}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        label={label}
        align={align}
        haspopup="menu"
        className="min-w-52 p-1"
      >
        <MenuList label={label}>{children}</MenuList>
      </Popover>
    </MenuCloseContext.Provider>
  );
}

function MenuList({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useContext(MenuCloseContext);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []),
    ];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index <= 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-0.5"
    >
      {children}
    </div>
  );
}

export interface MenuItemProps extends Omit<ComponentPropsWithoutRef<"button">, "onSelect"> {
  icon?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}

export function MenuItem({
  icon,
  danger = false,
  checked = false,
  onSelect,
  className,
  type = "button",
  children,
  onClick,
  ...props
}: MenuItemProps) {
  const close = useContext(MenuCloseContext);
  return (
    <button
      type={type}
      role="menuitem"
      className={cn(
        "flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50",
        "disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "text-danger hover:bg-danger/10" : "text-text-main hover:bg-panel-hover",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        onSelect?.();
        // A submit control must stay mounted until the browser posts the form.
        if (type !== "submit") close();
      }}
      {...props}
    >
      {icon && (
        <span aria-hidden className="shrink-0">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {checked && <Check size={16} className="shrink-0 text-brand-cyan" />}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="my-1 border-0 border-t border-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
      {children}
    </div>
  );
}

export interface OverflowMenuProps {
  /** Accessible name and tooltip for the 3-dots button. */
  label: string;
  align?: "start" | "end";
  id?: string;
  children: ReactNode;
}

/** The 3-dots button. Rare, secondary, and rare-destructive actions go here. */
export function OverflowMenu({ label, align = "end", id, children }: OverflowMenuProps) {
  return (
    <Menu
      label={label}
      align={align}
      trigger={<IconButton id={id} label={label} icon={<MoreVertical size={18} />} />}
    >
      {children}
    </Menu>
  );
}
