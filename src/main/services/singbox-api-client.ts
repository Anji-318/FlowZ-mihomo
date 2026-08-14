/**
 * singbox-api-client.ts — 兼容 shim。
 *
 * 内核已从 sing-box（gRPC StartedService）切换为 mihomo（Clash Meta，REST+WS external-controller）。
 * 本文件保留原模块路径与全部导出符号，实际实现位于 ./mihomo/mihomo-api-client，
 * 使 ProxyManager / StatsService / stats-worker / IPC 契约零改动（FlowZ UI 完全保留）。
 */
export {
  MihomoApiClient as SingBoxApiClient,
  mapConnection,
  flattenTailscalePeers,
  toTailscaleStatusPeers,
} from './mihomo/mihomo-api-client';
export type {
  SingBoxApiEndpoint,
  SingBoxApiTlsOptions,
  SingBoxConnection,
  SingBoxConnectionEvent,
  SingBoxConnectionEvents,
  SingBoxProcessInfo,
  SingBoxStatus,
  TailscaleEndpointStatus,
  TailscalePeer,
  TailscaleSelf,
  TailscaleUserGroup,
} from './mihomo/mihomo-api-client';
