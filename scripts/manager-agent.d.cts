import type { RemoteMetrics } from '../lib/managed-server-types'
export const PROTOCOL_VERSION: number
export const AGENT_VERSION: string
export const SETUP_CAPABILITY: string
export const UPDATE_CAPABILITY: string
export interface AgentApp {
  name: string; repo_url: string; branch: string; install_cmd: string; build_cmd: string; start_cmd: string;
  port: number; health_path: string; access_mode: 'lan' | 'wan'; hostname: string; ip_address: string; ip_port: number | null;
  environment: Record<string, string>
}
export function validateApp(input: unknown): AgentApp
export function sanitizeMetrics(input: unknown): RemoteMetrics
export function redact(value: string, secrets: string[]): string
export interface AgentDatabase {
  mode: 'create' | 'existing'; provider: 'postgresql' | 'mysql' | 'mariadb'; host: string; port: number;
  database: string; username: string; password: string; tls: boolean; managed?: boolean; adminUsername?: string; adminPassword?: string;
}
export function validateDatabase(input: unknown): AgentDatabase
export function databaseEnvironment(input: AgentDatabase): Record<string, string>
export function jobSecrets(input: Record<string, unknown>): string[]
