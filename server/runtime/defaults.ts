/**
 * 本地模拟账号常量。
 * 本地协议实现。
 * membership=ultra / subscription=active 等功能字段不变，仅展示文案差异。
 *
 * Agent 模式侧栏 = firstName + " " + lastName + planName（GetMe / GetPlanInfo）
 * Settings 邮箱 = cachedEmail / GetEmail
 */
export const InjectAccountEmail = "82719519@qq.com";

/** 本地假 JWT；仅写进 Cursor state.vscdb 与 auth mock，不访问真云端 */
export const InjectAuthToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsb2NhbC1saS1jaHV5aS11c2VyIiwiZW1haWwiOiI4MjcxOTUxOUBxcS5jb20iLCJ0eXBlIjoic2Vzc2lvbiIsImlzcyI6ImN1cnNvci1zdHVkaW8iLCJzY29wZSI6Im9wZW5pZCBwcm9maWxlIGVtYWlsIiwiZXhwIjo0MDcwOTA4ODAwfQ.local-state-token";

export const LocalRelayToken = InjectAuthToken;

export const LocalUltraMembershipType = "ultra";
export const LocalUltraSubscriptionStatus = "active";
export const LocalUltraPaymentID = "doubao-pro-local";
export const LocalUltraPlanIncludedCents = 20000;
export const LocalUltraDashboardUserID = 1;
export const LocalUltraSignUpType = "Google";

/** Settings / GetMe / Agent 侧栏展示名 → "李初一" */
export const InjectAccountFirstName = "李初一";
export const InjectAccountLastName = "";

/** GetPlanInfo 展示名（membership 仍是 ultra） */
export const InjectPlanDisplayName = "豆包Pro";

/** Default model context advertised to Cursor when no narrower setting exists. */
export const DefaultCursorContextWindowTokens = 200_000;
