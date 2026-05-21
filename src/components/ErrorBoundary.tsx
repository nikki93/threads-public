import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { ErrorBoundaryProps } from '../_types';
import { logActivity } from '../activity';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logActivity('pane_error', {
      label: this.props.label,
      message: error.message,
      stack: info.componentStack ?? null,
    });
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pane-error" role="alert">
        <div className="pane-error-title">{this.props.label} pane crashed</div>
        <pre className="pane-error-message">{this.state.error.message}</pre>
        <button type="button" className="pane-error-reset" onClick={this.reset}>
          retry
        </button>
      </div>
    );
  }
}
