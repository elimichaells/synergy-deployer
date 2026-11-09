export type AuditException = { projectId: string; package: string; advisory: string; reason: string; expiresAt: string }
export function formatAuditFindings(output: string): string
export function assertAuditPassed(result: {code: number; output: string}, scope?: string, options?: {projectId:string;exceptions:AuditException[];now?:number;accepted?:(entry:AuditException)=>void}): Record<string,number>
