import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export type AppLocale = "system" | "en" | "zh-CN";
type EffectiveLocale = "en" | "zh-CN";

const EN: Record<string, string> = {
  "language.title": "Language",
  "language.system": "System default",
  "language.english": "English",
  "language.chineseSimplified": "Simplified Chinese",
  "概览": "Overview",
  "用量": "Usage",
  "供应商": "Providers",
  "会话": "Sessions",
  "提示词": "Prompts",
  "设置": "Settings",
  "代理设置": "Connection",
  "外观": "Appearance",
  "Cursor 设置": "Cursor",
  "语言": "Language",
  "主导航": "Main navigation",
  "设置分类": "Settings sections",
  "返回供应商": "Back to providers",
  "返回供应商列表": "Back to provider list",
  "新增供应商": "Add provider",
  "保存供应商": "Save provider",
  "保存": "Save",
  "保存中": "Saving",
  "正在保存": "Saving",
  "取消": "Cancel",
  "确定": "Confirm",
  "关闭": "Close",
  "删除": "Delete",
  "编辑供应商": "Edit provider",
  "复制供应商": "Duplicate provider",
  "删除供应商": "Delete provider",
  "供应商概览": "Provider overview",
  "供应商列表": "Provider list",
  "模型服务连接状态": "Model service connection status",
  "已连接": "Connected",
  "未连接": "Disconnected",
  "启用中": "Enabled",
  "可用模型": "Available models",
  "连接正常": "Connected",
  "连接未通过": "Connection failed",
  "状态暂不可用": "Status unavailable",
  "未检测": "Not tested",
  "较慢": "Slow",
  "不可用": "Unavailable",
  "可进行测速": "Ready to test",
  "可点击测速后重试": "Run the speed test to retry",
  "请检查连接信息": "Check the connection details",
  "请检查服务地址和访问密钥": "Check the Base URL and API key",
  "供应商已启用": "Provider enabled",
  "供应商已停用": "Provider disabled",
  "供应商已删除": "Provider deleted",
  "供应商已保存": "Provider saved",
  "还没有供应商": "No providers yet",
  "从右上角添加第一个服务连接。": "Add your first provider from the top-right corner.",
  "连接": "Connection",
  "启用": "Enabled",
  "停用": "Disabled",
  "测试连接": "Test connection",
  "预设": "Preset",
  "自定义": "Custom",
  "名称": "Name",
  "类型": "Type",
  "接口": "API mode",
  "倍率": "Cost multiplier",
  "服务地址": "Base URL",
  "API 密钥": "API key",
  "模型": "Models",
  "拉取模型": "Fetch models",
  "默认模型": "Default model",
  "模型 ID": "Model ID",
  "筛选模型": "Filter models",
  "启用模型": "Enable model",
  "停用模型": "Disable model",
  "设为默认模型": "Set as default",
  "移除模型": "Remove model",
  "余额": "Balance",
  "未配置": "Not configured",
  "balance.unlimitedQuota": "Unlimited quota",
  "balance.unlimitedRateLimited": "Unlimited spending · rate limited",
  "balance.available": "{{remaining}} available",
  "balance.used": "{{used}} used",
  "balance.usedTotal": "{{used}} used / {{total}} total",
  "balance.newApiQuota": "{{remaining}} available ({{used}} used / {{total}} total)",
  "balance.sub2ApiQuota": "{{remaining}} available · {{used}} used",
  "balance.multiplier": "Multiplier {{value}}x",
  "刷新余额": "Refresh balance",
  "查询方式": "Detection",
  "自动识别 New API / Sub2API": "Auto-detect New API / Sub2API",
  "尚未查询": "Not checked yet",
  "保存后即可查询": "Save to check the balance",
  "查询完成": "Balance checked",
  "查询未成功": "Balance check failed",
  "余额已更新": "Balance updated",
  "余额查询未成功": "Balance check failed",
  "请检查相关信息": "Check the provider details",
  "OpenAI 兼容": "OpenAI compatible",
  "Anthropic 兼容": "Anthropic compatible",
  "请先填写服务地址和 API 密钥": "Enter the Base URL and API key first",
  "请先完善服务地址和 API 密钥": "Complete the Base URL and API key first",
  "请填写名称、服务地址和 API 密钥": "Enter a name, Base URL, and API key",
  "请先拉取模型或填写默认模型": "Fetch models or enter a default model",
  "保存后生效": "Takes effect after saving",
  "概览中心": "Overview",
  "社区与支持": "Community and support",
  "加入交流群": "Join the community",
  "联系作者": "Contact the author",
  "GitHub 仓库": "GitHub repository",
  "打赏作者": "Support the author",
  "检查更新": "Check for updates",
  "正在检查": "Checking",
  "当前已是最新版本": "You are up to date",
  "更新服务正在准备中": "The update service is starting",
  "暂时无法检查更新": "Update check failed",
  "发现新版本": "Update available",
  "新版本": "New version",
  "稍后再说": "Later",
  "立即更新": "Update now",
  "正在更新": "Updating",
  "正在下载": "Downloading",
  "正在校验": "Verifying",
  "正在下载更新并准备重新启动": "Downloading the update and preparing to restart",
  "更新暂时未完成，请稍后重试": "The update did not complete. Try again later.",
  "微信": "WeChat",
  "支付宝": "Alipay",
  "微信二维码": "WeChat QR code",
  "支付宝二维码": "Alipay QR code",
  "运行概况": "Runtime overview",
  "服务状态": "Service status",
  "服务已开启": "Service running",
  "服务已停止": "Service stopped",
  "开启服务": "Start service",
  "停止服务": "Stop service",
  "本次请求": "Current requests",
  "累计对话": "Total conversations",
  "成功率": "Success rate",
  "缓存命中率": "Cache hit rate",
  "缓存读取": "Cache reads",
  "直接输入": "Direct input",
  "缓存写入": "Cache writes",
  "估算费用": "Estimated cost",
  "最近更新": "Last updated",
  "常用功能": "Workspace",
  "推荐服务": "Featured provider",
  "精选服务": "Featured services",
  "查看详情": "View details",
  "前往官网": "Visit website",
  "暂时未能加载概览": "Overview unavailable",
  "暂时未能加载概览数据": "Overview data unavailable",
  "请确认本地服务已启动后重新加载。": "Make sure the local service is running, then reload.",
  "重新加载": "Reload",
  "暂无记录": "No records yet",
  "刚刚": "Just now",
  "用量概览": "Usage overview",
  "本地用量": "Local usage",
  "Token 用量": "Token usage",
  "费用": "Cost",
  "费用估算": "Estimated cost",
  "请求": "Requests",
  "请求次数": "Request count",
  "请求来源": "Request source",
  "请求明细": "Request details",
  "用量趋势": "Usage trend",
  "Token、请求和费用趋势": "Tokens, requests, and cost trend",
  "模型计费": "Model pricing",
  "供应商请求占比": "Requests by provider",
  "按供应商分布": "Distribution by provider",
  "统计范围": "Date range",
  "7 天": "7 days",
  "30 天": "30 days",
  "90 天": "90 days",
  "全部": "All",
  "全部供应商": "All providers",
  "全部模型": "All models",
  "全部状态": "All statuses",
  "全部来源": "All sources",
  "有效": "Successful",
  "异常": "Failed",
  "搜索": "Search",
  "搜索…": "Search...",
  "模型、供应商或错误": "Model, provider, or error",
  "清除筛选": "Clear filters",
  "导出当前筛选结果": "Export filtered results",
  "已导出 CSV": "CSV exported",
  "清空记录": "Clear records",
  "清空本地用量记录": "Clear local usage data",
  "清空用量和请求记录？": "Clear usage and request history?",
  "用量记录已清空": "Usage history cleared",
  "待定价": "Pricing unavailable",
  "等待价格目录": "Waiting for pricing catalog",
  "等待价格匹配": "Waiting for price match",
  "价格目录已更新": "Pricing catalog updated",
  "更新价格": "Refresh pricing",
  "刷新用量数据": "Refresh usage",
  "暂无请求": "No requests yet",
  "暂无匹配的请求记录": "No matching requests",
  "完成一次 Cursor 请求后，这里会同步显示用量与计费明细。": "Usage and pricing details appear here after a Cursor request.",
  "会话列表": "Session list",
  "会话显示方式": "Session view",
  "按最近活动查看": "Recent activity",
  "按项目分组": "Group by project",
  "搜索会话": "Search sessions",
  "所有项目": "All projects",
  "当前项目": "Current project",
  "暂无会话": "No sessions yet",
  "没有匹配的会话": "No matching sessions",
  "选择一个会话": "Select a session",
  "从左侧列表选择会话后，可在这里查看对话记录。": "Select a session on the left to view its conversation.",
  "对话记录": "Conversation",
  "读取中": "Loading",
  "正在读取对话记录": "Loading conversation",
  "暂无可显示的对话记录": "No conversation to display",
  "删除会话": "Delete session",
  "清理空会话": "Remove empty sessions",
  "多选会话": "Select sessions",
  "退出多选": "Exit selection",
  "全选本页": "Select page",
  "取消全选": "Clear selection",
  "会话已删除": "Session deleted",
  "提示词列表": "Prompt list",
  "管理常用提示词并按需启用": "Manage reusable prompts and enable them as needed",
  "搜索提示词": "Search prompts",
  "新增提示词": "Add prompt",
  "还没有提示词": "No prompts yet",
  "没有找到匹配的提示词": "No matching prompts",
  "提示词内容": "Prompt content",
  "输入提示词内容": "Enter prompt content",
  "说明": "Description",
  "简要说明适用的场景": "Describe when to use it",
  "应用提示词": "Apply prompts",
  "提示词已保存": "Prompt saved",
  "提示词已删除": "Prompt deleted",
  "提示词已同步": "Prompts synchronized",
  "MCP 服务列表": "MCP servers",
  "管理可连接的工具服务": "Manage connected tool servers",
  "新增 MCP": "Add MCP",
  "新增 MCP 服务": "Add MCP server",
  "搜索 MCP 服务": "Search MCP servers",
  "还没有 MCP 服务": "No MCP servers yet",
  "没有匹配的 MCP 服务": "No matching MCP servers",
  "检测全部": "Test all",
  "检测中": "Testing",
  "未开启": "Disabled",
  "正常": "Healthy",
  "可用": "Available",
  "工具": "Tools",
  "管理": "Manage",
  "Skills 列表": "Skills",
  "管理 Cursor 可识别的常用能力": "Manage reusable capabilities available to Cursor",
  "新增技能": "Add skill",
  "刷新 Skills": "Refresh skills",
  "搜索 Skills": "Search skills",
  "已有技能": "Installed skills",
  "可导入 Skills": "Discoverable skills",
  "技能来源": "Skill sources",
  "来源管理": "Sources",
  "添加来源": "Add source",
  "导入此技能": "Install skill",
  "更新此技能": "Update skill",
  "还没有可用技能": "No skills yet",
  "没有匹配的技能": "No matching skills",
  "技能已保存": "Skill saved",
  "技能已创建": "Skill created",
  "技能已导入": "Skill installed",
  "技能已更新": "Skill updated",
  "技能已删除": "Skill deleted",
  "连接状态": "Connection status",
  "刷新状态": "Refresh status",
  "保存设置": "Save settings",
  "连接选项": "Connection options",
  "通常无需修改，遇到连接问题时再调整。": "Change these only when troubleshooting connectivity.",
  "应用地址": "Proxy address",
  "管理地址": "Backend address",
  "通常无需修改": "Usually unchanged",
  "连接方式": "Connection mode",
  "选择 Cursor 使用的连接方式。": "Choose how Cursor connects.",
  "使用 Studio（推荐）": "Use Studio (recommended)",
  "使用 Cursor 默认连接": "Use Cursor defaults",
  "保存后会在下次连接时生效。": "Takes effect on the next connection.",
  "备份与恢复": "Backup and restore",
  "保存当前设置，也可以导入、导出或恢复已保存的内容。最多保留最近三份备份。": "Export, import, or restore settings. Up to three backups are retained.",
  "导出设置": "Export settings",
  "导入设置": "Import settings",
  "创建备份": "Create backup",
  "清理备份": "Clear backups",
  "导出支持信息": "Export diagnostics",
  "还没有设置备份": "No backups yet",
  "创建备份后可以在这里恢复。": "Create a backup to restore it here.",
  "恢复此备份": "Restore backup",
  "删除此备份": "Delete backup",
  "Cursor 连接": "Cursor connection",
  "连接 Cursor": "Connect Cursor",
  "移除连接": "Disconnect",
  "修复连接": "Repair connection",
  "打开 Cursor 设置": "Open Cursor settings",
  "安全证书": "Security certificate",
  "安装证书": "Install certificate",
  "查看证书": "View certificate",
  "已准备": "Ready",
  "未准备": "Not ready",
  "安全证书只会安装到当前 Windows 账户。": "The certificate is installed only for the current Windows user.",
  "外观设置": "Appearance settings",
  "外观概览": "Appearance overview",
  "启用媒体背景": "Enable media background",
  "背景素材": "Background media",
  "选择素材或粘贴网络地址": "Choose media or paste a URL",
  "图片或视频": "Image or video",
  "透明效果": "Transparency",
  "柔化程度": "Blur",
  "显示方式": "Layout",
  "自动轮换": "Auto rotate",
  "轮换间隔": "Rotation interval",
  "实时预览": "Live preview",
  "应用到 Cursor": "Apply to Cursor",
  "清除效果": "Remove appearance",
  "恢复默认": "Restore defaults",
  "Cursor 更新后，重新应用外观即可恢复当前设置。": "Reapply the appearance after a Cursor update.",
  "账户资料": "Profile",
  "显示名称": "Display name",
  "邮箱": "Email",
  "套餐名称": "Plan name",
  "头像地址": "Avatar URL",
  "选择头像": "Choose avatar",
  "使用默认头像": "Use default avatar",
  "个人标识": "Profile handle",
  "个人主页": "Website",
  "默认对话容量": "Default context window",
  "Cursor 设置已保存": "Cursor settings saved",
  "加载中": "Loading",
  "加载中…": "Loading...",
  "启动中…": "Starting...",
  "重试": "Retry",
  "刷新": "Refresh",
  "检测": "Test",
  "查看": "View",
  "添加": "Add",
  "创建": "Create",
  "导入": "Import",
  "更新": "Update",
  "移除": "Remove",
  "清理": "Clean up",
  "应用": "Apply",
  "完成": "Done",
  "状态": "Status",
  "时间": "Time",
  "项目": "Project",
  "内容": "Content",
  "来源": "Source",
  "输入": "Input",
  "输出": "Output",
  "缓存": "Cache",
  "成功": "Successful",
  "待检查": "Pending check",
  "待处理": "Pending",
  "未知时间": "Unknown time",
  "请稍后重试": "Try again later",
  "请稍后重试。": "Try again later.",
  "暂时无法打开链接，请稍后再试": "The link could not be opened. Try again later.",
  "界面渲染失败": "The interface failed to render",
  "无法连接控制面": "Could not connect to the control plane",
  "控制面已连接，但尚未读到有效配置。": "The control plane is connected, but no valid configuration was returned.",
};

const EN_UI_EXTRA: Record<string, string> = {
  "update.message.desktopRequiredCheck": "Use the installed desktop app to check for updates.",
  "update.message.desktopRequiredInstall": "Use the installed desktop app to install updates.",
  "update.message.developmentOnly": "Updates are available in installed builds only.",
  "update.message.windowsOnly": "Automatic updates are currently available on Windows only.",
  "update.message.notConfigured": "The update service is not configured.",
  "update.message.available": "Cursor Studio v{{version}} is available.",
  "update.message.upToDate": "You are up to date.",
  "update.message.checkFailed": "The update check failed. Check your connection and try again.",
  "update.message.noUpdate": "There is no update to install.",
  "update.message.restarting": "The update was verified. Installation is starting, and the app will restart.",
  "update.message.installFailed": "The update could not be installed. Try again later.",
  "dynamic.updateAvailableCurrent": "Update available. Current version {{version}}",
  "dynamic.currentVersion": "Current version {{version}}",
  "dynamic.reopenDesktop": "{{error}} · Reopen the Cursor Studio desktop app (or run npm run dev)",
  "dynamic.controlUnavailable": "Could not connect to the control plane at {{base}} ({{error}}). Start Cursor Studio or run npm run dev.",
  "dynamic.items": "{{count}} items",
  "dynamic.models": "{{count}} models",
  "dynamic.tools": "{{count}} tools",
  "dynamic.messages": "{{count}} messages",
  "dynamic.fetchedModels": "Fetched {{count}} models",
  "dynamic.updatedModels": "Updated {{count}} models",
  "dynamic.minutesAgo": "{{count}} minutes ago",
  "dynamic.hoursAgo": "{{count}} hours ago",
  "dynamic.daysAgo": "{{count}} days ago",
  "dynamic.updatedMinutesAgo": "Updated {{count}} minutes ago",
  "dynamic.updatedHoursAgo": "Updated {{count}} hours ago",
  "dynamic.updatedDaysAgo": "Updated {{count}} days ago",
  "dynamic.mediaOpacity": "Media opacity {{value}}",
  "dynamic.windowOpacity": "Window opacity {{value}}",
  "dynamic.surfaceOpacity": "Content opacity {{value}}",
  "dynamic.blur": "Acrylic blur {{value}}px",
  "dynamic.importFailed": "Import failed: {{error}}",
  "dynamic.restoreBackup": "Restore the settings from {{date}}. The current settings will be backed up first.",
  "dynamic.deleteBackup": "Delete the backup from {{date}}? This cannot be undone.",
  "dynamic.deleteBackups": "Delete all {{count}} saved backups? This cannot be undone.",
  "dynamic.saveContext": "The default context window will be set to {{context}}.",
  "dynamic.contextApplied": "Default context window applied: {{context}}. Individual models can override it.",
  "dynamic.cacheHitRate": "Cache hit rate {{value}}",
  "dynamic.successfulRequests": "{{count}} successful requests",
  "dynamic.downloading": "Downloading{{percent}}",
  "dynamic.detectedTools": "Detected {{count}} tools.",
  "dynamic.detectedToolsLatency": "Detected {{count}} tools, response {{latency}}ms.",
  "dynamic.removeNamed": "Remove \"{{name}}\"?",
  "dynamic.deleteNamed": "Delete {{name}}",
  "dynamic.testNamed": "Test {{name}}",
  "dynamic.removeNamedAction": "Remove {{name}}",
  "dynamic.manageNamed": "Manage \"{{name}}\"",
  "dynamic.serverResponse": "Response {{latency}}ms; {{count}} tools available.",
  "dynamic.serverHealthy": "Connected; detected {{count}} tools.",
  "dynamic.promptEnabled": "Enabled \"{{name}}\"",
  "dynamic.promptDisabled": "Disabled \"{{name}}\"",
  "dynamic.copyName": "{{name}} (copy)",
  "dynamic.deletePrompt": "Delete \"{{name}}\"? This cannot be undone.",
  "dynamic.toggleNamed": "{{action}} {{name}}",
  "dynamic.providerConnected": "{{name}} connected",
  "dynamic.providerFailed": "{{name}} connection failed",
  "dynamic.providerCopied": "Copied {{name}}",
  "dynamic.providerState": "{{name}} {{state}}",
  "dynamic.deleteSessions": "Delete {{count}} sessions",
  "dynamic.deletedSessionsPartial": "Deleted {{removed}} sessions; {{failed}} did not complete",
  "dynamic.deletedSessions": "Deleted {{count}} sessions",
  "dynamic.cleanedSessionsPartial": "Removed {{removed}} empty sessions; {{failed}} did not complete",
  "dynamic.cleanedSessions": "Removed {{count}} empty sessions and their files",
  "dynamic.selectSession": "Select {{name}}",
  "dynamic.allProjects": "All projects ({{count}})",
  "dynamic.discoveredSkills": "Found {{count}} installable skills.",
  "dynamic.repositoryAction": "{{action}} {{name}}",
  "dynamic.providerRequests": "{{name}}: {{count}} requests",
  "dynamic.dayRequests": "{{date}}, {{count}} requests",
  "dynamic.repriced": "Recalculated {{updated}} requests; {{unpriced}} still need price matches.",
  "dynamic.pricingCatalog": "Pricing catalog {{date}}",
  "dynamic.rangeRequests": "Local proxy requests in {{range}}",
  "dynamic.failedRequests": "{{count}} failed requests",
  "dynamic.inputOutput": "Input {{input}} · output {{output}}",
  "dynamic.pricedRequests": "{{count}} priced requests",
  "dynamic.catalogModels": "{{count}} models",
  "dynamic.matchingRecords": "{{count}} matching records",
  "dynamic.priceDetails": "Input ${{input}}/1M · output ${{output}}/1M · multiplier {{multiplier}}x",
  "，当前设置已开启。": ", enabled in the current settings.",
  "，当前应用已暂停。": ", currently paused.",
  "· 缓存": "· Cache",
  "· 输出": "· Output",
  "· 异常": "· Failed",
  "安装": "Install",
  "安装安全证书": "Install security certificate",
  "安装后可稳定处理安全连接请求。": "Install it to handle secure connection requests reliably.",
  "安装后可稳定建立需要安全验证的连接，之后可随时从系统设置中移除。": "Install it to establish verified secure connections. You can remove it later from system settings.",
  "按当前筛选范围聚合": "Aggregated for the current filters",
  "按设定时间切换素材。": "Rotate media at the configured interval.",
  "按项目归类": "Group by project",
  "按最近活动排序": "Sort by recent activity",
  "保存失败": "Save failed",
  "保存未完成，请稍后重试": "The save did not complete. Try again later.",
  "保存未完成，请稍后重试。": "The save did not complete. Try again later.",
  "保存账户": "Save account",
  "备份已清理": "Backups cleared",
  "备份已删除": "Backup deleted",
  "背景类型": "Background type",
  "本机会话累计": "Local session total",
  "编辑器": "Editor",
  "变亮": "Lighten",
  "补充资料": "Profile details",
  "测速": "Speed test",
  "查看当前外观是否已生效。": "Check whether the current appearance is active.",
  "查看对话目录": "Open conversation folder",
  "查看服务位置": "Open server location",
  "查看提示词位置": "Open prompt location",
  "查询中": "Checking",
  "查找可导入技能": "Find skills to install",
  "产生新会话后会显示在这里。": "New sessions will appear here.",
  "常用上下文长度": "Common context sizes",
  "撤销修改": "Discard changes",
  "成功率 ·": "Success rate ·",
  "出错了": "Something went wrong",
  "处理中": "Processing",
  "窗口显示": "Window",
  "创建失败": "Create failed",
  "创建一条可单独启用和管理的提示词。": "Create a prompt that can be enabled and managed independently.",
  "创建中": "Creating",
  "此操作会移除本地保存的用量统计和最近请求明细。": "This removes locally stored usage statistics and recent request details.",
  "次": "requests",
  "次 ·": "requests ·",
  "次请求": "requests",
  "打开失败": "Open failed",
  "待确认": "Needs confirmation",
  "待填写": "Required",
  "待完善": "Incomplete",
  "待应用": "Ready to apply",
  "当前范围内暂无来源数据": "No source data in the current range",
  "当前范围内暂无模型计费数据": "No model cost data in the current range",
  "当前范围内暂无趋势数据": "No trend data in the current range",
  "当前会话": "Current session",
  "当前连接未通过": "The current connection failed",
  "当前设置的对话容量": "Configured context window",
  "当前时段": "Current period",
  "当前素材信息": "Current media",
  "当前外观还需要处理": "The current appearance needs attention",
  "当前外观可以应用": "The current appearance is ready to apply",
  "当前外观需要处理": "The current appearance needs attention",
  "当前外观已在 Cursor 中生效。": "The current appearance is active in Cursor.",
  "当前外观已准备就绪": "The current appearance is ready",
  "当前页没有会话": "No sessions on this page",
  "当前已是最新内容": "Already up to date",
  "导出失败": "Export failed",
  "导入前会自动保留当前设置备份，导入文件中的连接和外观选项会立即替换当前内容。": "A backup is created before import. Connection and appearance settings from the imported file replace the current values immediately.",
  "导入失败": "Import failed",
  "导入中": "Importing",
  "等待检测": "Waiting for test",
  "等待连接": "Waiting for connection",
  "等待首次更新": "Waiting for first update",
  "等待数据": "Waiting for data",
  "等待应用外观": "Waiting to apply appearance",
  "底部对齐": "Align bottom",
  "第": "Page",
  "点击左侧开启": "Enable from the left",
  "调整 Cursor 内显示的头像、名称、邮箱和套餐。": "Adjust the avatar, name, email, and plan shown in Cursor.",
  "调整关键词后再试。": "Adjust the keywords and try again.",
  "调整搜索或筛选条件后再试。": "Adjust the search or filters and try again.",
  "调整搜索或项目筛选后再试。": "Adjust the search or project filter and try again.",
  "调整素材、窗口和内容区域的显示层次。": "Tune the media, window, and content surface layers.",
  "顶部对齐": "Align top",
  "豆包Pro": "Doubao Pro",
  "读": "Read",
  "读取会话失败": "Failed to load session",
  "对话轮次": "Conversation turns",
  "对话目录": "Conversation folder",
  "对话容量": "Context window",
  "多": "More",
  "多条同时启用": "Enable multiple",
  "访问令牌": "Access token",
  "分支": "Branch",
  "服务连接未通过": "Service connection failed",
  "服务连接正常": "Service connected",
  "服务已移除": "Service removed",
  "该会话没有可读取的消息。": "This session has no readable messages.",
  "刚刚更新": "Updated just now",
  "个 MCP 服务，已确认": "MCP servers, verified",
  "个查找来源。": "discovery sources.",
  "个工具": "tools",
  "个技能，其中": "skills, including",
  "个可导入技能。": "installable skills.",
  "个可管理。": "manageable.",
  "个来源暂时无法获取内容，稍后可再次刷新。": "sources are temporarily unavailable. Refresh again later.",
  "个连接正常。": "connections healthy.",
  "个模型": "models",
  "个模型等待匹配": "models awaiting price matches",
  "个模型已匹配价格": "models matched to pricing",
  "个人技能": "Personal skills",
  "个已启用": "enabled",
  "跟随系统": "System default",
  "更新这条提示词的名称、说明和内容。": "Update this prompt's name, description, and content.",
  "供应商余额账户": "Provider balance accounts",
  "共": "Total",
  "关闭后会保留当前素材，方便下次继续使用。": "The current media is kept so you can use it again later.",
  "关闭后会保留已选择的提示词，方便下次继续使用。": "Selected prompts are kept so you can use them again later.",
  "管理 MCP 服务": "Manage MCP servers",
  "管理技能": "Manage skills",
  "管理提示词": "Manage prompts",
  "还没有查找来源": "No discovery sources yet",
  "还没有发现可导入技能": "No installable skills found yet",
  "含写入": "Include writes",
  "缓存命中": "Cache hits",
  "缓存效率": "Cache efficiency",
  "缓存与 Token 使用数据": "Cache and token usage",
  "换个关键词试试，或清除搜索后查看全部提示词。": "Try another keyword, or clear the search to view all prompts.",
  "恢复": "Restore",
  "恢复默认头像": "Restore default avatar",
  "恢复默认外观？": "Restore the default appearance?",
  "恢复设置备份": "Restore settings backup",
  "恢复未完成，请稍后重试。": "Restore did not complete. Try again later.",
  "会话目录及其中的全部文件会一并删除，且无法恢复。": "The session folder and all files inside it will be permanently deleted.",
  "即时更新": "Live update",
  "即时更新到 Cursor": "Update Cursor live",
  "即时更新已开启": "Live update enabled",
  "计入写入": "Include writes",
  "记忆": "Memory",
  "技能内容不能为空": "Skill content cannot be empty",
  "价格更新失败": "Pricing update failed",
  "价格目录等待更新": "Pricing catalog waiting for update",
  "价格目录尚未同步": "Pricing catalog not synchronized",
  "检测并保存": "Test and save",
  "检测到提示词内容发生变化，请重新同步以应用当前设置。": "Prompt content changed. Synchronize again to apply the current settings.",
  "检测到以前的外观效果，下次应用时会自动整理。": "A previous appearance was found and will be cleaned up on the next apply.",
  "检测服务后，这里会显示可用工具。": "Available tools appear here after the server is tested.",
  "检测失败": "Test failed",
  "检查连接信息后重新检测。": "Check the connection details and test again.",
  "检查外观": "Check appearance",
  "检查未完成，请稍后重试。": "The check did not complete. Try again later.",
  "检查中": "Checking",
  "简体中文": "Simplified Chinese",
  "简要说明它适合处理什么内容": "Briefly describe what it is useful for",
  "建议使用容易识别的名称": "Use a recognizable name",
  "将把当前外观应用到 Cursor。首次应用后请完全重启 Cursor。": "This applies the current appearance to Cursor. Fully restart Cursor after the first apply.",
  "将恢复此前可用的 Cursor 外观。建议先退出 Cursor。": "This restores the previous Cursor appearance. Exit Cursor first.",
  "将移除已应用到 Cursor 的外观，并保留当前设置供下次继续使用。": "This removes the applied Cursor appearance while keeping the current settings for later.",
  "仅会清理由本应用创建、但当前已失效的连接设置。": "Only stale connection settings created by this app are removed.",
  "仅检测": "Test only",
  "近 180 天": "Last 180 days",
  "近 180 天请求活跃度": "Request activity over the last 180 days",
  "静态背景": "Static background",
  "就绪": "Ready",
  "可查看": "Viewable",
  "可导入": "Installable",
  "可导入内容已刷新": "Installable content refreshed",
  "可更新": "Update available",
  "可管理": "Manageable",
  "可留空": "Optional",
  "可留空使用兼容接口探测": "Optional; leave blank to probe compatible endpoints",
  "可用会话": "Available sessions",
  "快捷预设": "Quick presets",
  "来源已添加": "Source added",
  "来源已移除": "Source removed",
  "来源已用于查找": "Source enabled for discovery",
  "来源已暂停查找": "Source discovery paused",
  "来自": "From",
  "李初一": "Li Chuyi",
  "例如 200000": "For example, 200000",
  "例如 专业版": "For example, Pro",
  "例如 Cursor Studio": "For example, Cursor Studio",
  "例如 cursor-studio": "For example, cursor-studio",
  "例如 support@example.com": "For example, support@example.com",
  "例如：通用编程助手": "For example: General coding assistant",
  "例如：团队/项目 或 GitHub 地址": "For example: team/project or GitHub URL",
  "例如：项目规范": "For example: project guidelines",
  "连接到 Cursor": "Connect to Cursor",
  "连接服务已准备，等待 Cursor 连接。": "The connection service is ready and waiting for Cursor.",
  "连接和安全维护": "Connection and security",
  "连接和运行设置": "Connection and runtime settings",
  "连接检测未通过，请进入管理后检查连接信息。": "The connection test failed. Open Manage and check the connection details.",
  "连接未通过，请检查连接信息后重新检测。": "Connection failed. Check the details and test again.",
  "连接信息": "Connection details",
  "另存": "Save as",
  "另存提示词": "Save prompt as",
  "毛玻璃": "Acrylic",
  "毛玻璃效果已启用": "Acrylic effect enabled",
  "没有对话记录的会话目录及其中全部文件会被删除，且无法恢复。": "Session folders without conversations and all files inside them will be permanently deleted.",
  "没有可清理的空会话": "No empty sessions to clean up",
  "没有匹配的可导入技能": "No matching installable skills",
  "没有匹配的来源": "No matching sources",
  "没有匹配的模型": "No matching models",
  "没有需要修复的连接": "No connections need repair",
  "媒体背景已启用": "Media background enabled",
  "每页显示": "Items per page",
  "秒": "seconds",
  "命中": "Hit",
  "模型 / 供应商": "Model / provider",
  "模型供应商": "Model providers",
  "默认口径": "Default calculation",
  "内容读取失败": "Failed to read content",
  "内容较长，仅显示开头部分。": "The content is long; only the beginning is shown.",
  "内置技能": "Built-in skills",
  "内置提示词": "Built-in prompts",
  "你": "You",
  "配置为空": "Configuration is empty",
  "平铺": "Tile",
  "铺满窗口": "Fill window",
  "其他来源": "Other sources",
  "启动 Cursor 后再刷新状态。": "Start Cursor, then refresh the status.",
  "启用方式": "Enable mode",
  "启用余额查询": "Enable balance lookup",
  "切换精选服务": "Switch featured provider",
  "切换上一页或下一页继续查看。": "Use the previous or next page to continue.",
  "清除": "Remove",
  "清除搜索": "Clear search",
  "清除未完成，请稍后重试。": "Removal did not complete. Try again later.",
  "清空失败": "Clear failed",
  "清理没有对话记录的会话及其文件": "Remove sessions without conversations and their files",
  "清理全部备份": "Clear all backups",
  "清零": "Reset",
  "请检查地址后重试。": "Check the URL and try again.",
  "请检查连接信息后重试。": "Check the connection details and try again.",
  "请检查连接状态后重新加载。": "Check the connection status and reload.",
  "请检查名称后重试。": "Check the name and try again.",
  "请求活跃度": "Request activity",
  "请求运行正常": "Requests are healthy",
  "请确认 Cursor 已启动并检查当前素材后再次尝试。": "Make sure Cursor is running, check the current media, and try again.",
  "请确认后继续。": "Confirm to continue.",
  "请稍后重新刷新状态。": "Refresh the status again later.",
  "请输入 1,024 到 2,147,483,647 之间的整数": "Enter an integer from 1,024 to 2,147,483,647",
  "请输入 1,024 到 2,147,483,647 之间的整数。": "Enter an integer from 1,024 to 2,147,483,647.",
  "请输入 GitHub 仓库地址": "Enter a GitHub repository URL",
  "请输入技能名称": "Enter a skill name",
  "请输入提示词名称": "Enter a prompt name",
  "请输入提示词内容": "Enter prompt content",
  "请填写 API Key 或访问令牌": "Enter an API key or access token",
  "请填写账户名称和站点地址": "Enter an account name and site URL",
  "请选择图片文件作为头像": "Choose an image file for the avatar",
  "趋势图例": "Trend legend",
  "全部对话": "All conversations",
  "全部服务": "All services",
  "删除此供应商": "Delete this provider",
  "删除此会话": "Delete this session",
  "删除前会保留一份备份，删除后该技能将不再可用。": "A backup is kept before deletion. The skill will no longer be available afterward.",
  "删除设置备份": "Delete settings backup",
  "删除失败": "Delete failed",
  "删除提示词？": "Delete prompt?",
  "上一次连接未完成，请检查连接状态后再试。": "The previous connection did not complete. Check its status and try again.",
  "上一条": "Previous",
  "尚未获取工具列表": "Tool list not loaded",
  "尚未检测该服务。": "This server has not been tested.",
  "尚未检测连接状态，可先运行检测确认服务是否可用。": "Connection status has not been tested. Run a test to verify the server.",
  "尚未填写说明。": "No description provided.",
  "少": "Less",
  "设置更新失败": "Settings update failed",
  "设置已保存": "Settings saved",
  "设置已导入": "Settings imported",
  "设置已恢复": "Settings restored",
  "设置状态": "Settings status",
  "使用概览": "Usage overview",
  "使用无图毛玻璃": "Use acrylic without media",
  "视频": "Video",
  "刷新发现": "Refresh discovery",
  "刷新服务列表": "Refresh servers",
  "刷新会话": "Refresh sessions",
  "刷新模型": "Refresh models",
  "刷新全部余额": "Refresh all balances",
  "刷新失败": "Refresh failed",
  "刷新提示词": "Refresh prompts",
  "顺序思考": "Sequential thinking",
  "搜索服务或工具": "Search servers or tools",
  "搜索可导入技能": "Search installable skills",
  "搜索来源": "Search sources",
  "搜索名称、说明或场景": "Search name, description, or use case",
  "搜索名称、说明或使用范围": "Search name, description, or scope",
  "素材": "Media",
  "素材和显示效果已通过检查，可以应用到 Cursor。": "The media and display effects passed validation and can be applied to Cursor.",
  "素材位置": "Media position",
  "素材文件夹": "Media folder",
  "随时可用": "Available anytime",
  "提示词加载失败": "Failed to load prompts",
  "提示词加载失败，请稍后重试。": "Failed to load prompts. Try again later.",
  "提示词设置": "Prompt settings",
  "提示词同步需要处理": "Prompt synchronization needs attention",
  "提示词已另存": "Prompt saved as a copy",
  "提示词应用已暂停": "Prompt application paused",
  "添加 NewAPI 或 Sub2API 账户": "Add a New API or Sub2API account",
  "添加查找来源": "Add discovery source",
  "添加来源后，即可查找并导入新的技能。": "Add a source to discover and install new skills.",
  "添加来源后，刷新即可查看可导入的技能。": "Add a source, then refresh to view installable skills.",
  "添加失败": "Add failed",
  "添加账户": "Add account",
  "添加中": "Adding",
  "填写 GitHub 仓库地址后，即可发现其中可导入的技能。": "Enter a GitHub repository URL to discover installable skills.",
  "条": "items",
  "条 · 共": "items · total",
  "条提示词": "prompts",
  "停止服务？": "Stop service?",
  "停止后，Cursor 将暂时停止使用已配置的模型服务。": "Cursor will temporarily stop using configured model providers.",
  "同步失败": "Synchronization failed",
  "同名项": "items with the same name",
  "头像请使用 HTTPS 图片地址或本地图片文件": "Use an HTTPS image URL or local image file for the avatar",
  "头像选择未完成，请稍后重试": "Avatar selection did not complete. Try again later.",
  "头像已设置": "Avatar configured",
  "图片": "Image",
  "图片和视频都可以作为背景，留空时只保留毛玻璃效果。": "Images and videos can be used as backgrounds. Leave this blank to keep only the acrylic effect.",
  "外观操作": "Appearance actions",
  "外观检查结果": "Appearance check result",
  "外观设置已保存": "Appearance settings saved",
  "外观效果": "Appearance effect",
  "外观效果已清除": "Appearance removed",
  "外观效果已应用": "Appearance applied",
  "外观已应用": "Appearance applied",
  "完成设置后点击“应用到 Cursor”。": "Click Apply to Cursor after finishing the settings.",
  "完整显示": "Fit",
  "网络素材": "Remote media",
  "未标记供应商": "Unlabeled provider",
  "未标记模型": "Unlabeled model",
  "未单独设置的模型会使用该容量，继续对话时会按对应长度保留历史内容。": "Models without an individual setting use this context window when retaining conversation history.",
  "未启用": "Disabled",
  "未设置默认模型": "No default model",
  "文件系统": "File system",
  "无法读取对话记录": "Could not read conversation history",
  "无素材": "No media",
  "无需素材": "No media required",
  "下一条": "Next",
  "先选择素材文件夹后再开启。": "Choose a media folder before enabling this option.",
  "显示效果": "Display effect",
  "项": "items",
  "写": "Write",
  "新建后可在所有项目中使用，也可以随时回来完善内容。": "After creation, it is available in all projects and can be edited later.",
  "新增 MCP 服务后，可以在这里统一查看、检测和管理。": "Add an MCP server to view, test, and manage it here.",
  "新增技能后，可以在这里统一查看和管理。": "Add a skill to view and manage it here.",
  "新增一条提示词后，可以在这里统一查看和管理。": "Add a prompt to view and manage it here.",
  "修复": "Repair",
  "修复旧连接": "Repair old connection",
  "修改会立即反映在此处。": "Changes appear here immediately.",
  "修改内容后会立即保存到这项技能。": "Changes are saved to this skill immediately.",
  "需要处理": "Needs attention",
  "选择": "Choose",
  "选择包含图片或视频的文件夹": "Choose a folder containing images or videos",
  "选择常用服务或粘贴连接信息。保存前会先检查连接。": "Choose a preset or enter connection details. The connection is tested before saving.",
  "选择账户编辑，或添加一个余额账户": "Choose an account to edit or add a balance account",
  "循环静音播放": "Loop muted",
  "移除后，该服务将不再出现在当前列表中。": "After removal, this server no longer appears in the list.",
  "移除失败": "Remove failed",
  "移除已应用的外观？": "Remove the applied appearance?",
  "已保存": "Saved",
  "已创建设置备份": "Settings backup created",
  "已打开所在位置": "Location opened",
  "已导入的技能会继续保留。": "Installed skills are kept.",
  "已发现": "Discovered",
  "已关闭": "Off",
  "已恢复保存的外观设置": "Saved appearance settings restored",
  "已恢复默认效果": "Default appearance restored",
  "已开启": "On",
  "已开启提示词应用": "Prompt application enabled",
  "已连接到 Cursor": "Connected to Cursor",
  "已配置账户": "Configured accounts",
  "已匹配价格": "Pricing matched",
  "已启用": "Enabled",
  "已切换为多条同时启用": "Switched to multiple active prompts",
  "已切换为只保留一条": "Switched to one active prompt",
  "已设置价格": "Custom pricing",
  "已识别": "Detected",
  "已添加": "Added",
  "已添加到所有项目。": "Added to all projects.",
  "已添加服务": "Servers added",
  "已停用": "Disabled",
  "已同步技能": "Skills synchronized",
  "已修复旧连接": "Old connection repaired",
  "已选": "Selected",
  "已选素材": "Selected media",
  "已选择": "Selected",
  "已移除连接": "Connection removed",
  "已应用": "Applied",
  "已有": "Existing",
  "已有同名技能，不会覆盖": "A skill with this name already exists and will not be overwritten",
  "已暂停": "Paused",
  "已最新": "Up to date",
  "以当前内容创建一条可单独管理的新提示词。": "Create a separately managed prompt from the current content.",
  "应用外观到 Cursor？": "Apply appearance to Cursor?",
  "应用外观后，调整参数会自动更新到 Cursor。": "After applying, parameter changes update Cursor automatically.",
  "应用未完成，请检查 Cursor 后重试。": "Apply did not complete. Check Cursor and try again.",
  "应用状态": "Apply status",
  "用户 ID": "User ID",
  "用量数据刷新失败": "Failed to refresh usage data",
  "用于查找可导入技能": "Used to discover installable skills",
  "用于自动轮换": "Used for automatic rotation",
  "有": "Yes",
  "有未保存修改": "Unsaved changes",
  "右侧对齐": "Align right",
  "右上对齐": "Align top right",
  "右下对齐": "Align bottom right",
  "余额账户已保存": "Balance account saved",
  "余额账户已删除": "Balance account deleted",
  "原尺寸居中": "Center at original size",
  "越低越透明": "Lower values are more transparent",
  "在下方调整素材和透明效果，保存后可随时重新应用。": "Adjust media and transparency below. Saved settings can be reapplied anytime.",
  "暂不参与查找": "Excluded from discovery",
  "暂时未能读取设置状态": "Could not read settings status",
  "暂时未能加载设置状态": "Could not load settings status",
  "暂停": "Pause",
  "暂未发现 Cursor": "Cursor not detected",
  "暂无内容": "No content",
  "暂无数据": "No data",
  "暂无消息": "No messages",
  "暂无应用状态。": "No apply status yet.",
  "站点 / Base URL": "Site / Base URL",
  "账户按站点地址与 Cursor 供应商自动关联，余额会直接显示在供应商列表。": "Accounts are matched to Cursor providers by site URL, and balances appear in the provider list.",
  "这些信息会同步到 Cursor 的个人资料中。": "This information is synchronized to your Cursor profile.",
  "正片叠底": "Multiply",
  "正在读取": "Loading",
  "正在读取应用状态": "Loading apply status",
  "正在加载 MCP 服务": "Loading MCP servers",
  "正在加载 Skills": "Loading skills",
  "正在加载概览数据": "Loading overview data",
  "正在加载会话": "Loading sessions",
  "正在加载提示词": "Loading prompts",
  "正在加载用量数据": "Loading usage data",
  "证书已准备，可用于安全连接。": "The certificate is ready for secure connections.",
  "支持 HTTPS 图片地址或本地图片": "Supports HTTPS image URLs or local images",
  "支持信息已导出": "Diagnostics exported",
  "只保留一条": "Keep one active",
  "只支持 HTTPS 链接": "HTTPS links only",
  "重新读取": "Reload",
  "重新同步": "Synchronize again",
  "助手": "Assistant",
  "状态读取失败": "Failed to read status",
  "状态更新失败": "Status update failed",
  "准备好连接服务后可在这里连接。": "Connect here after the connection service is ready.",
  "自定义连接": "Custom connection",
  "自定义提示词": "Custom prompts",
  "自定义余额接口": "Custom balance endpoint",
  "自动轮换背景素材": "Automatically rotate background media",
  "最小化": "Minimize",
  "左侧对齐": "Align left",
  "左上偏移": "Offset top left",
  "Cursor 将使用当前连接方式。开始前请确认连接服务已准备就绪。": "Cursor will use the current connection mode. Make sure the service is ready before continuing.",
  "Cursor 正在使用当前连接方式。": "Cursor is using the current connection mode.",
  "Cursor Studio 已准备好新的功能与体验优化。": "A new Cursor Studio release is ready with features and experience improvements.",
  "GitHub 仓库地址": "GitHub repository URL",
  "https://api.example.com 或 https://api.example.com/v1": "https://api.example.com or https://api.example.com/v1",
  "MCP 服务加载失败": "Failed to load MCP servers",
  "MCP 服务加载失败，请稍后重试。": "Failed to load MCP servers. Try again later.",
  "MCP 服务筛选": "MCP server filters",
  "MCP 服务已保存": "MCP server saved",
  "NewAPI 后台令牌或 Sub2API JWT": "New API dashboard token or Sub2API JWT",
  "NewAPI 可选": "Optional for New API",
  "Skills 加载失败": "Failed to load skills",
  "Skills 加载失败，请稍后重试。": "Failed to load skills. Try again later.",
  "Skills 筛选": "Skill filters",
  "Skills 视图": "Skills view",
  "Token、费用与请求量": "Tokens, cost, and requests",
  "稳定、便捷的 AI 中转服务。": "A stable and convenient AI relay service.",
  "合作席位": "Partner slot",
  "虚位以待": "Available",
  "如需入驻，请联系作者。": "Contact the author to be featured here.",
};

const ZH_CN: Record<string, string> = {
  "language.title": "语言",
  "language.system": "跟随系统",
  "language.english": "English",
  "language.chineseSimplified": "简体中文",
  "balance.unlimitedQuota": "无限额度",
  "balance.unlimitedRateLimited": "不限额度 · 受速率限制",
  "balance.available": "{{remaining}} 可用",
  "balance.used": "已用 {{used}}",
  "balance.usedTotal": "已用 {{used}} / 总计 {{total}}",
  "balance.newApiQuota": "{{remaining}} 可用（已用 {{used}} / 总计 {{total}}）",
  "balance.sub2ApiQuota": "{{remaining}} 可用 · 已用 {{used}}",
  "balance.multiplier": "倍率 {{value}}x",
  "update.message.desktopRequiredCheck": "请使用已安装的桌面应用检查更新。",
  "update.message.desktopRequiredInstall": "请使用已安装的桌面应用安装更新。",
  "update.message.developmentOnly": "仅已安装的正式版本支持在线更新。",
  "update.message.windowsOnly": "自动更新目前仅支持 Windows。",
  "update.message.notConfigured": "更新服务尚未配置。",
  "update.message.available": "发现 Cursor Studio v{{version}}。",
  "update.message.upToDate": "当前已是最新版本。",
  "update.message.checkFailed": "更新检查失败，请检查网络后重试。",
  "update.message.noUpdate": "当前没有可安装的更新。",
  "update.message.restarting": "更新已校验，正在安装并重新启动应用。",
  "update.message.installFailed": "更新安装失败，请稍后重试。",
  "Please use the installed desktop app to check for updates.": "请使用已安装的桌面应用检查更新。",
  "Please use the installed desktop app to install updates.": "请使用已安装的桌面应用安装更新。",
};

function savedLocale(): AppLocale {
  if (typeof window === "undefined") return "system";
  const value = window.localStorage.getItem("cursor-studio.locale");
  return value === "en" || value === "zh-CN" ? value : "system";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: { ...EN, ...EN_UI_EXTRA } },
    "zh-CN": { translation: ZH_CN },
  },
  lng: resolveLocale(savedLocale()),
  fallbackLng: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  initAsync: false,
});

export function resolveLocale(locale?: AppLocale): EffectiveLocale {
  if (locale === "en" || locale === "zh-CN") return locale;
  const systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language || "";
  return /^zh(?:-|$)/i.test(systemLanguage) ? "zh-CN" : "en";
}

export function currentIntlLocale(): "en-US" | "zh-CN" {
  const active = i18n.resolvedLanguage || i18n.language;
  return /^zh(?:-|$)/i.test(active) ? "zh-CN" : "en-US";
}

export async function setI18nLocale(locale: AppLocale): Promise<void> {
  if (typeof window !== "undefined") {
    window.localStorage.setItem("cursor-studio.locale", locale);
  }
  const effective = resolveLocale(locale);
  document.documentElement.lang = effective;
  await i18n.changeLanguage(effective);
}

function translatedToken(value: string): string {
  return String(i18n.t(value, { defaultValue: value }));
}

function translatedDynamic(key: string, values: Record<string, string | number>): string {
  return String(i18n.t(key, values));
}

function translateDynamicUiText(text: string): string {
  let match: RegExpMatchArray | null;

  if ((match = text.match(/^发现新版本，当前版本\s+(.+)$/))) {
    return translatedDynamic("dynamic.updateAvailableCurrent", { version: match[1] });
  }
  if ((match = text.match(/^当前版本\s+(.+)$/))) {
    return translatedDynamic("dynamic.currentVersion", { version: match[1] });
  }
  if ((match = text.match(/^(.+)\s+·\s+请重新打开 Cursor Studio 桌面应用（或 npm run dev）$/))) {
    return translatedDynamic("dynamic.reopenDesktop", { error: match[1] });
  }
  if ((match = text.match(/^无法连接控制面\s+(.+)（(.+)）。请启动 Cursor Studio 桌面应用或 npm run dev。$/))) {
    return translatedDynamic("dynamic.controlUnavailable", { base: match[1], error: match[2] });
  }
  if ((match = text.match(/^(\d+)\s*条$/))) {
    return translatedDynamic("dynamic.items", { count: match[1] });
  }
  if ((match = text.match(/^共\s*(\d+)\s*条$/))) {
    return translatedDynamic("dynamic.items", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*个模型$/))) {
    return translatedDynamic("dynamic.models", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*个工具$/))) {
    return translatedDynamic("dynamic.tools", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*条消息$/))) {
    return translatedDynamic("dynamic.messages", { count: match[1] });
  }
  if ((match = text.match(/^已拉取\s*(\d+)\s*个模型$/))) {
    return translatedDynamic("dynamic.fetchedModels", { count: match[1] });
  }
  if ((match = text.match(/^已更新\s*(\d+)\s*个模型$/))) {
    return translatedDynamic("dynamic.updatedModels", { count: match[1] });
  }
  if ((match = text.match(/^媒体透明度\s+(.+)$/))) {
    return translatedDynamic("dynamic.mediaOpacity", { value: match[1] });
  }
  if ((match = text.match(/^窗口透明度\s+(.+)$/))) {
    return translatedDynamic("dynamic.windowOpacity", { value: match[1] });
  }
  if ((match = text.match(/^内容区透明度\s+(.+)$/))) {
    return translatedDynamic("dynamic.surfaceOpacity", { value: match[1] });
  }
  if ((match = text.match(/^毛玻璃模糊\s+(.+)px$/))) {
    return translatedDynamic("dynamic.blur", { value: match[1] });
  }
  if ((match = text.match(/^导入失败：(.+)$/))) {
    return translatedDynamic("dynamic.importFailed", { error: match[1] });
  }
  if ((match = text.match(/^将恢复\s+(.+)\s+的设置，当前内容会先自动备份。$/))) {
    return translatedDynamic("dynamic.restoreBackup", { date: match[1] });
  }
  if ((match = text.match(/^将删除\s+(.+)\s+的备份，之后无法恢复。$/))) {
    return translatedDynamic("dynamic.deleteBackup", { date: match[1] });
  }
  if ((match = text.match(/^将删除当前保存的\s*(\d+)\s*份备份，之后无法恢复。$/))) {
    return translatedDynamic("dynamic.deleteBackups", { count: match[1] });
  }
  if ((match = text.match(/^保存后将应用\s+(.+)\s+的默认容量。$/))) {
    return translatedDynamic("dynamic.saveContext", { context: match[1] });
  }
  if ((match = text.match(/^默认容量已应用：(.+)。具体模型可单独设置。$/))) {
    return translatedDynamic("dynamic.contextApplied", { context: match[1] });
  }
  if ((match = text.match(/^缓存命中率\s+(.+)$/))) {
    return translatedDynamic("dynamic.cacheHitRate", { value: match[1] });
  }
  if ((match = text.match(/^(.+)\s+次成功$/))) {
    return translatedDynamic("dynamic.successfulRequests", { count: match[1] });
  }
  if ((match = text.match(/^正在下载(?:\s+(\d+%))?$/))) {
    return translatedDynamic("dynamic.downloading", { percent: match[1] ? ` ${match[1]}` : "" });
  }
  if ((match = text.match(/^已识别\s*(\d+)\s*个工具(?:，响应\s*(\d+)ms)?。$/))) {
    return match[2]
      ? translatedDynamic("dynamic.detectedToolsLatency", { count: match[1], latency: match[2] })
      : translatedDynamic("dynamic.detectedTools", { count: match[1] });
  }
  if ((match = text.match(/^连接响应\s*(\d+)ms，可使用\s*(\d+)\s*个工具。$/))) {
    return translatedDynamic("dynamic.serverResponse", { latency: match[1], count: match[2] });
  }
  if ((match = text.match(/^连接正常，已识别\s*(\d+)\s*个工具。$/))) {
    return translatedDynamic("dynamic.serverHealthy", { count: match[1] });
  }
  if ((match = text.match(/^已启用「(.+)」$/))) {
    return translatedDynamic("dynamic.promptEnabled", { name: match[1] });
  }
  if ((match = text.match(/^已停用「(.+)」$/))) {
    return translatedDynamic("dynamic.promptDisabled", { name: match[1] });
  }
  if ((match = text.match(/^(.+)（副本）$/))) {
    return translatedDynamic("dynamic.copyName", { name: match[1] });
  }
  if ((match = text.match(/^确定删除「(.+)」吗？此操作无法恢复。$/))) {
    return translatedDynamic("dynamic.deletePrompt", { name: match[1] });
  }
  if ((match = text.match(/^移除「(.+)」？$/))) {
    return translatedDynamic("dynamic.removeNamed", { name: match[1] });
  }
  if ((match = text.match(/^删除「(.+)」？$/))) {
    return translatedDynamic("dynamic.removeNamed", { name: match[1] });
  }
  if ((match = text.match(/^管理「(.+)」$/))) {
    return translatedDynamic("dynamic.manageNamed", { name: match[1] });
  }
  if ((match = text.match(/^检测\s+(.+)$/))) {
    return translatedDynamic("dynamic.testNamed", { name: match[1] });
  }
  if ((match = text.match(/^删除\s+(.+)$/))) {
    return translatedDynamic("dynamic.deleteNamed", { name: match[1] });
  }
  if ((match = text.match(/^移除\s+(.+)$/))) {
    return translatedDynamic("dynamic.removeNamedAction", { name: match[1] });
  }
  if ((match = text.match(/^(启用|停用|暂停)\s+(.+)$/))) {
    return translatedDynamic("dynamic.toggleNamed", {
      action: translatedToken(match[1]),
      name: match[2],
    });
  }
  if ((match = text.match(/^(.+)\s+连接正常$/))) {
    return translatedDynamic("dynamic.providerConnected", { name: match[1] });
  }
  if ((match = text.match(/^(.+)\s+连接未通过$/))) {
    return translatedDynamic("dynamic.providerFailed", { name: match[1] });
  }
  if ((match = text.match(/^已复制\s+(.+)$/))) {
    return translatedDynamic("dynamic.providerCopied", { name: match[1] });
  }
  if ((match = text.match(/^(.+?)(已启用|已停用)$/))) {
    return translatedDynamic("dynamic.providerState", {
      name: match[1],
      state: translatedToken(match[2]),
    });
  }
  if ((match = text.match(/^删除\s*(\d+)\s*个会话$/))) {
    return translatedDynamic("dynamic.deleteSessions", { count: match[1] });
  }
  if ((match = text.match(/^已删除\s*(\d+)\s*个会话，\s*(\d+)\s*个未完成$/))) {
    return translatedDynamic("dynamic.deletedSessionsPartial", {
      removed: match[1],
      failed: match[2],
    });
  }
  if ((match = text.match(/^已删除\s*(\d+)\s*个会话$/))) {
    return translatedDynamic("dynamic.deletedSessions", { count: match[1] });
  }
  if ((match = text.match(/^已清理\s*(\d+)\s*个空会话，\s*(\d+)\s*个未完成$/))) {
    return translatedDynamic("dynamic.cleanedSessionsPartial", {
      removed: match[1],
      failed: match[2],
    });
  }
  if ((match = text.match(/^已清理\s*(\d+)\s*个空会话及其文件$/))) {
    return translatedDynamic("dynamic.cleanedSessions", { count: match[1] });
  }
  if ((match = text.match(/^选择\s+(.+)$/))) {
    return translatedDynamic("dynamic.selectSession", { name: match[1] });
  }
  if ((match = text.match(/^全部项目\s*\((\d+)\)$/))) {
    return translatedDynamic("dynamic.allProjects", { count: match[1] });
  }
  if ((match = text.match(/^发现\s*(\d+)\s*个可导入技能。$/))) {
    return translatedDynamic("dynamic.discoveredSkills", { count: match[1] });
  }
  if ((match = text.match(/^(暂停|启用)\s+(.+)$/))) {
    return translatedDynamic("dynamic.repositoryAction", {
      action: translatedToken(match[1]),
      name: match[2],
    });
  }
  if ((match = text.match(/^(\d+)\s*分钟前更新$/))) {
    return translatedDynamic("dynamic.updatedMinutesAgo", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*小时前更新$/))) {
    return translatedDynamic("dynamic.updatedHoursAgo", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*天前更新$/))) {
    return translatedDynamic("dynamic.updatedDaysAgo", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*分钟前$/))) {
    return translatedDynamic("dynamic.minutesAgo", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*小时前$/))) {
    return translatedDynamic("dynamic.hoursAgo", { count: match[1] });
  }
  if ((match = text.match(/^(\d+)\s*天前$/))) {
    return translatedDynamic("dynamic.daysAgo", { count: match[1] });
  }
  if ((match = text.match(/^(.+):\s*(\d+)\s*次请求$/))) {
    return translatedDynamic("dynamic.providerRequests", { name: match[1], count: match[2] });
  }
  if ((match = text.match(/^(.+)，\s*(\d+)\s*次请求$/))) {
    return translatedDynamic("dynamic.dayRequests", { date: match[1], count: match[2] });
  }
  if ((match = text.match(/^已重算\s*(\d+)\s*条请求，\s*(\d+)\s*条待匹配。$/))) {
    return translatedDynamic("dynamic.repriced", { updated: match[1], unpriced: match[2] });
  }
  if ((match = text.match(/^价格目录\s+(.+)$/))) {
    return translatedDynamic("dynamic.pricingCatalog", { date: match[1] });
  }
  if ((match = text.match(/^(.+)内的本地代理请求$/))) {
    return translatedDynamic("dynamic.rangeRequests", { range: translatedToken(match[1]) });
  }
  if ((match = text.match(/^(\d+)\s*次异常$/))) {
    return translatedDynamic("dynamic.failedRequests", { count: match[1] });
  }
  if ((match = text.match(/^输入\s+(.+)\s+·\s+输出\s+(.+)$/))) {
    return translatedDynamic("dynamic.inputOutput", { input: match[1], output: match[2] });
  }
  if ((match = text.match(/^(\d+)\s*条已定价$/))) {
    return translatedDynamic("dynamic.pricedRequests", { count: match[1] });
  }
  if ((match = text.match(/^(.+)\s*个模型$/))) {
    return translatedDynamic("dynamic.catalogModels", { count: match[1] });
  }
  if ((match = text.match(/^(.+)\s*条匹配记录$/))) {
    return translatedDynamic("dynamic.matchingRecords", { count: match[1] });
  }
  if ((match = text.match(/^输入 \$(.+)\/1M · 输出 \$(.+)\/1M · 倍率 (.+)x$/))) {
    return translatedDynamic("dynamic.priceDetails", {
      input: match[1],
      output: match[2],
      multiplier: match[3],
    });
  }

  return text;
}

export function translateUiText(value: string): string {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const text = value.trim();
  if (!text) return value;
  let translated = i18n.t(text, { defaultValue: text });
  if (
    translated === text &&
    /[\u3400-\u9fff]/.test(text) &&
    /^en(?:-|$)/i.test(i18n.resolvedLanguage || i18n.language)
  ) {
    translated = translateDynamicUiText(text);
  }
  return `${leading}${translated}${trailing}`;
}

export function tr(value: string): string {
  return translateUiText(value);
}

export default i18n;
