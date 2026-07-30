# 更新日志

## 1.0.4

### 新增

- 新增基于 i18next 的简体中文与英文界面，首次启动自动匹配 Windows 系统语言，并支持在标题栏快速切换。
- 新增 New API 与 Sub2API 供应商余额自动获取，只需 Base URL 与 API Key；地址填写带或不带 `/v1` 均可使用。
- 新增供应商倍率设置与列表展示，用量计费会按照对应倍率计算。
- 新增供应商定时监测，每 10 分钟刷新延迟、模型价格和余额；手动检测延迟时也会同步刷新余额。

### 优化

- 重写英文 README，并提供完整的简体中文 README，补充功能、架构、安装、配置、隐私和贡献说明。
- 优化概览与用量页的命中、缓存读取、直接输入、缓存写入及数值加载动画。
- 恢复 Sonner 通知的进入、退出、堆叠和拖拽动画，并兼容减少动态效果设置。
- 改进在线更新的超时、状态提示和 GitHub Release 回退逻辑，避免检查过程长期停留在加载状态。
- 更新 Electron、Playwright、GitHub Actions 与 Radix Tooltip，并修复依赖安全告警。

### 修复

- 修复赞助二维码静态资源缺失。
- 修复 Cursor 配置中历史乱码名称的检测与迁移。
- 修复部分界面文本编码异常。
- 修复供应商倍率变更后概览与用量页面估算费用不同步的问题。
- 修复切换界面语言时供应商名称、会话内容等用户数据被意外翻译的问题。

### Added

- Added Simplified Chinese and English interfaces powered by i18next, automatic Windows locale detection, and a title-bar language switcher.
- Added automatic balance discovery for New API and Sub2API providers using only a Base URL and API key; URLs work with or without `/v1`.
- Added provider multipliers in settings and provider summaries; usage billing now applies the configured multiplier.
- Added a provider monitor that refreshes latency, model pricing, and balances every 10 minutes; manual latency checks refresh balances too.

### Improved

- Rebuilt the English README and added a complete Simplified Chinese edition covering features, architecture, installation, configuration, privacy, and contribution.
- Improved metric and count-up animations for overview and usage data, including cache hits, cache reads, direct input, and cache writes.
- Restored Sonner enter, exit, stacking, and drag transitions with reduced-motion support.
- Hardened online updates with timeouts, clearer status messages, and GitHub Release fallback behavior so checks no longer spin indefinitely.
- Updated Electron, Playwright, GitHub Actions, and Radix Tooltip, resolving dependency security alerts.

### Fixed

- Restored missing donation QR code assets.
- Repaired detection and migration of legacy mojibake names in Cursor configuration.
- Fixed remaining text encoding issues in the interface.
- Kept overview and usage cost estimates in sync after a provider multiplier changes.
- Preserved provider names, session content, and other user data when switching the interface language.

## 1.0.3

- 修复部分会话出现重复思考、重复回复或内容异常清空的问题。
- 提升 Plan 模式、长会话、工具调用和断线恢复的稳定性。
- 优化服务异常与上下文超限时的提示和恢复体验。

## 1.0.2

- 公开发布 Cursor Studio 源码与协作规范。
- 统一 Windows 安装与应用内更新为 MSI 安装包。
- 清理历史构建产物与过期开发记录。
- 优化仓库文档、赞助入口和社区协作配置。

## 1.0.1

- 修复应用图标、更新检查、托盘退出和多服务显示。
- 发布 Windows MSI 安装包。
