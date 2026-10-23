export const REPOSITORY: string
export const MAX_PACKAGE: number
export function verifyAndStage(file: string,dir: string,current: string,trustFile: string): Promise<{ version: string; sourceCommit: string }>
export function inventory(root: string): Promise<Record<string,string>>
