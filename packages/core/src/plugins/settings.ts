import { DEFAULT_PROCESS_LIMITS, type ProcessLimits } from '../util/child-process.js';

export interface PluginHostSettings {
  /** Delay before restart number n after a crash (the last value repeats). */
  restartBackoffMs: number[];
  /** Consecutive crashes before a plugin is marked failed. */
  maxCrashes: number;
  /** A run at least this long resets the consecutive-crash count. */
  stableAfterMs: number;
  /** How long a stopping plugin may finish running tool calls. */
  drainTimeoutMs: number;
  initializeTimeoutMs: number;
  /** After `stop`, how long before SIGTERM. */
  stopTimeoutMs: number;
  /** Memory and file-descriptor limits of plugin and MCP processes; over the memory limit they restart. */
  limits: ProcessLimits;
  /** Outbound rate limit: tool calls per connector plugin per minute (null: unlimited). */
  outboundPerMinute: number | null;
}

export const DEFAULT_PLUGIN_HOST_SETTINGS: PluginHostSettings = {
  restartBackoffMs: [1000, 2000, 4000, 8000, 16000, 32000, 60000],
  maxCrashes: 5,
  stableAfterMs: 60_000,
  drainTimeoutMs: 30_000,
  initializeTimeoutMs: 20_000,
  stopTimeoutMs: 5_000,
  limits: { ...DEFAULT_PROCESS_LIMITS },
  outboundPerMinute: 20,
};
