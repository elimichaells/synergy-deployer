export interface UpdateConfig { managerRoot: string; stateRoot: string; nodeExe: string; pm2Home: string; pm2PackageRoot: string; pgDump: string; port: number }
export interface UpdateState { id: string; source: string; userId: string; phase: string; fromVersion: string; version: string; createdAt: string; updatedAt: string; commit?: string; manualRollback?: boolean; recoveryStarted?: boolean; events: { at: string; message: string }[] }
export const TERMINAL: string[]
export function config(root?: string): UpdateConfig
export function json(file: string): any
export function maintenance(root?: string): boolean
export function compare(a: string,b: string): number
export function atomic(file: string,value: unknown): void
export function jobDir(c: UpdateConfig,id: string): string
export function currentJob(c: UpdateConfig): { dir: string; state: UpdateState } | null
export function save(dir: string,state: UpdateState,phase?: string,message?: string): void
