import type { RunResult } from './exec.js';

/** The wire contract between the `shell` plugin and the sandbox agent (docs/40-plan/08-sandbox-browser-vision.md §2.2). */
export const SANDBOX_PROTOCOL_VERSION = 1;

export const DEFAULT_SANDBOX_SOCKET = '/run/protea-sandbox/agent.sock';

export const SANDBOX_METHODS = {
  hello: 'hello',
  shellRun: 'shell/run',
  shellCancel: 'shell/cancel',
  sessionReset: 'session/reset',
  jobStart: 'job/start',
  jobList: 'job/list',
  jobLogs: 'job/logs',
  jobStop: 'job/stop',
  jobAck: 'job/ack',
  /** Agent → plugin notification: a job ended, or was lost with the previous container. */
  jobEnded: 'job/ended',
} as const;

export type JobState = 'running' | 'exited' | 'stopped' | 'lost';

export interface JobInfo {
  id: string;
  name?: string;
  command: string;
  session: string;
  cwd: string;
  state: JobState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
}

/** A job that ended and has not been acknowledged by the plugin. */
export interface JobEnded {
  /** Distinguishes this sandbox home from a later one, for event deduplication. */
  instance: string;
  job: JobInfo;
  tail: string;
}

export interface HelloResult {
  protocolVersion: number;
  instance: string;
  workspace: string;
  home: string;
  unacked: JobEnded[];
}

export interface ShellRunParams {
  runId: string;
  session: string;
  command: string;
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  captureBytes: number;
  env?: Record<string, string>;
}

export interface ShellRunResult extends RunResult {
  /** The shell's directory after the command; absent when the state was not kept. */
  cwd?: string;
}

export interface JobStartParams {
  session: string;
  command: string;
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Most running jobs allowed. */
  maxRunning: number;
  /** Most log bytes kept per job. */
  logBytes: number;
}
