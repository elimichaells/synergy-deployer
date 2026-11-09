'use client'
import { cn } from '@/lib/utils'

export function RuntimeView({active,onChange}:{active:string;onChange:(tab:string)=>void}) {
  return <div className="mb-4 flex h-8 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="Runtime view">
    {(['logs','console'] as const).map(value=><button key={value} type="button" onClick={()=>onChange(value)} aria-pressed={active===value} className={cn('h-full rounded-[5px] px-3 text-xs',active===value?'bg-white/[0.09] text-foreground':'text-muted-foreground hover:text-foreground')}>{value==='logs'?'Logs':'Console'}</button>)}
  </div>
}
