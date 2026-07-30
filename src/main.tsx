import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import i18n, { tr } from "./lib/i18n";
import "./styles/tokens.css";
import "./styles/index.css";
import "./styles/app-pro.css";
import "./styles/desktop-app.css";
import "./styles/desktop-product.css";
import "./styles/usage-dashboard.css";
import "./styles/readability.css";
import "./styles/provider-workspace.css";
import "./styles/sessions-workspace.css";
import "./styles/prompts-workspace.css";
import "./styles/tools-workspace.css";
import "./styles/config-workspace.css";
import "./styles/cursor-settings-workspace.css";
import "./styles/appearance-workspace.css";
import "./styles/motion.css";

function isChineseLocale(): boolean {
  return /^zh(?:-|$)/i.test(i18n.resolvedLanguage || i18n.language || "");
}

document.documentElement.lang = isChineseLocale() ? "zh-CN" : "en";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    console.error("[studio] render error", err);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            background: "#f5f5f7",
            color: "#111",
            fontFamily: "Segoe UI, system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 16, marginBottom: 8 }}>{tr("界面渲染失败")}</h1>
            <p style={{ fontSize: 13, color: "#666", wordBreak: "break-all" }}>
              {this.state.error}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  const fallback = document.createElement("p");
  fallback.style.padding = "24px";
  fallback.textContent = isChineseLocale()
    ? "缺少 #root 挂载节点"
    : "The #root mount node is missing";
  document.body.replaceChildren(fallback);
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
