// file: frontend/src/components/ErrorBoundary.tsx
import { AlertTriangle, RefreshCw, Wrench } from "lucide-react";
import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { I18nContext } from "../context/I18nContext";
import { captureReport } from "../utils/errorCapture";
import { Button, Card } from "./ui";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  static contextType = I18nContext;
  declare context: React.ContextType<typeof I18nContext>;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo): void {
    try {
      captureReport("react-render", error);
    } catch {
      // never throw
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const t = this.context?.t || ((key: string) => key);
      return (
        <div className="flex min-h-[50vh] items-center justify-center p-4">
          <Card className="max-w-md w-full text-center border-danger/30">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-danger/10 text-danger">
              <AlertTriangle size={24} />
            </div>
            <h2 className="mt-4 text-lg font-bold text-text-main">{t("errorBoundaryTitle")}</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted sm:text-sm">
              {t("errorBoundaryDesc")}
            </p>
            {this.state.error?.message && (
              <pre
                dir="ltr"
                className="mt-3 overflow-x-auto rounded-lg bg-panel p-2 font-mono text-[11px] leading-relaxed text-danger border border-line text-start"
              >
                {this.state.error.message}
              </pre>
            )}
            <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button
                variant="primary"
                onClick={() => window.location.reload()}
                icon={<RefreshCw size={16} />}
                className="w-full sm:w-auto"
              >
                {t("errorBoundaryReload")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  window.location.hash = "settings/diagnostics";
                  this.setState({ hasError: false, error: null });
                }}
                icon={<Wrench size={16} />}
                className="w-full sm:w-auto"
              >
                {t("errorBoundaryGoDiagnostics")}
              </Button>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
