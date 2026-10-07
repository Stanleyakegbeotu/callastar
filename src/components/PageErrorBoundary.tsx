import { Component, type ErrorInfo, type ReactNode } from "react";
import { productionDiagnostic } from "@/lib/productionDiagnostics";

export class PageErrorBoundary extends Component<{ children: ReactNode; admin?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    productionDiagnostic("ADMIN_ROUTE_LOAD_FAILED", { kind: this.props.admin ? "admin" : "application" });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="page-error" role="alert">
      <h1>Something went wrong loading this page.</h1>
      <div className="admin-card-actions">
        <button className="admin-button admin-button-primary" onClick={() => this.setState({ failed: false })}>Try Again</button>
        <a className="admin-button admin-button-secondary" href="/admin">Back to Admin</a>
      </div>
    </section>;
  }
}
export default PageErrorBoundary;
