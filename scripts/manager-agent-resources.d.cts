import type { ProcessRow } from '../lib/server-memory-policy'
export const CAPABILITY:string
export interface ResourceMetrics {
 at:string;root:string;error:string|null;commitMb:number|null;commitLimitMb:number|null;pageFileMb:number|null;pageFileUsedMb:number|null
 processes:ProcessRow[]
 apps:{id:string;cwd:string;limitMb:number|null;method:'direct'|'runner';direct:boolean;reason:string;sleepAfterMinutes:number|null;sleepingSince:string|null;lastActiveAt:string|null}[]
 workers:{id:string;status:string;pid:number;memory:number;cpu:number;restarts:number;uptime:number}[]
}
export function sanitize(raw:unknown):ResourceMetrics|null
