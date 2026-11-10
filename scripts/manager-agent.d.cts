import type { RemoteMetrics } from '../lib/managed-server-types'
export const PROTOCOL_VERSION: number
export const AGENT_VERSION: string
export function toolVersion(id:string):Promise<string>
export const SETUP_CAPABILITY: string
export const UPDATE_CAPABILITY: string
export const CONSOLE_CAPABILITY: string
export const RUNTIME_CAPABILITY:string
export const SERVICE_TOOLS_CAPABILITY:string
export const LAN_CAPABILITY:string
export function validateLanSelection(hostname:string,metrics:unknown):void
export function validateRuntimeSelection(value:unknown,metrics:unknown):Record<string,string>
export function validateRuntimeVersions(value:unknown):Record<string,string>
export interface AgentApp {
  name: string; repo_url: string; branch: string; install_cmd: string; build_cmd: string; start_cmd: string;
  deploy_script:string;pre_deploy_cmd:string;post_deploy_cmd:string;
  port: number; health_path: string; access_mode: 'lan' | 'wan'; hostname: string; ip_address: string; ip_port: number | null;
  environment: Record<string, string>;runtime_versions:Record<string,string>
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

export const INFRASTRUCTURE_CAPABILITY: string

export const CONSOLE_DETAILS_CAPABILITY:string

export const DATABASE_BROWSER_CAPABILITY:string
