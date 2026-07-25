import { AppearancePage } from "@/pages/AppearancePage";
import { ConfigPage } from "@/pages/ConfigPage";
import { CursorSettingsPage } from "@/pages/CursorSettingsPage";
import type { AppearanceConfig, AppConfig } from "@/lib/api";

export type SettingsTab = "proxy" | "appearance" | "cursor";

export function SettingsPage({
  activeTab,
  config,
  onConfigChange,
  onAppearanceChange,
  onPreviewChange,
}: {
  activeTab: SettingsTab;
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onAppearanceChange: (appearance: AppearanceConfig) => void;
  onPreviewChange: (appearance: AppearanceConfig) => void;
}) {
  if (activeTab === "appearance") {
    return (
      <AppearancePage
        appearance={config.appearance}
        onChange={onAppearanceChange}
        onPreviewChange={onPreviewChange}
      />
    );
  }

  if (activeTab === "cursor") {
    return <CursorSettingsPage config={config} onConfigChange={onConfigChange} />;
  }

  return <ConfigPage config={config} onConfigChange={onConfigChange} />;
}
