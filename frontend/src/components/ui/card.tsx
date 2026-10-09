// file: frontend/src/components/ui/card.tsx
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  /** Default true. Turn off when the card is a flush table or media frame. */
  padded?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, padded = true, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-2xl border border-line bg-panel shadow-sm",
        padded && "p-4 md:p-5",
        className,
      )}
      {...props}
    />
  );
});

/** Same surface as Card. Use the name that matches the sentence you are writing. */
export const Panel = Card;

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {icon && (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-cyan/10 text-brand-cyan">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-text-main md:text-lg">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Page title block on a card. */
export function PageHeader({
  className,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader {...props} />
    </Card>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {title && <CardHeader title={title} description={description} actions={actions} />}
      {children}
    </section>
  );
}
