'use client'
import {Play} from 'lucide-react'
import {Button} from '@/components/ui/button'

export function ConsoleCommands({commands,scripts,disabled,onRun}:{commands:string[];scripts:Record<string,string>;disabled:boolean;onRun:(command:string)=>void}){
  if(!commands.length&&!Object.keys(scripts).length)return null
  return <div className="mb-4 flex flex-wrap gap-2">
    {commands.map(command=><Button key={command} variant="outline" size="sm" className="font-mono text-xs" disabled={disabled} onClick={()=>onRun(command)}>{command}</Button>)}
    {Object.entries(scripts).filter(([name])=>/^[A-Za-z0-9_.:-]{1,100}$/.test(name)).map(([name,script])=><Button key={name} variant="secondary" size="sm" className="font-mono text-xs" disabled={disabled} title={script} onClick={()=>onRun(`npm run ${name}`)}><Play className="mr-1.5 h-3 w-3"/>{name}</Button>)}
  </div>
}
