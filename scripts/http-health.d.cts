export interface HealthProfile { path: string; statuses: number[]; timeoutMs: number }
export function validateHealthProfile(value?: unknown): HealthProfile;
export function probeHttp(url: string, options?: { statuses?: number[]; signal?: AbortSignal; diagnostics?: boolean }, request?: typeof fetch): Promise<{ ok: boolean; status: number | null; reason?: string; diagnostics?: { dependency: string; issueCode: string; detail: string; nextStep: string } }>;
