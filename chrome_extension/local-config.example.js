// Copy this file as local-config.js. It is intentionally excluded from Git.
// Use the same token value as NAVER_AGENT_TOKEN in D:\JumpingBattle_SuwonYT\.env.
globalThis.NAVER_RESERVATION_CONFIG = {
  businessId: 1376430,
  endpoint: "http://127.0.0.1:8081/api/integrations/naver/reservations",
  stockPlanEndpoint: "http://127.0.0.1:8081/api/integrations/naver/stock-plan",
  agentToken: "paste-the-NAVER_AGENT_TOKEN-here",
  pollMinutes: 1,
  // false = disabled, "dry-run" = check only, true = change Naver stock.
  stockSyncEnabled: false
};
