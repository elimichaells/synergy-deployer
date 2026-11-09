export function projectQuickCommands(type: string): string[]
export function consoleGitArguments(command: string): string[] | null
export function completeCommand(command:string,entries:string[],commands:string[],windows:boolean): {command:string;matches:string[]}
export function consoleInfo(value:unknown): {entries:string[];scripts:Record<string,string>}
