'use client'
import { useRef,useState } from 'react'
import { Check,Copy,Square,Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
export function ConsoleTerminal({title,cwd,command,onCommand,output,outputText,running,disabled,onRun,onStop,onClear,onComplete,onHistory,inputRef:externalInput,outputRef}:{title:string;cwd:string;command:string;onCommand:(value:string)=>void;output:React.ReactNode;outputText:string;running:boolean;disabled:boolean;onRun:()=>void;onStop:()=>void;onClear:()=>void;onComplete?:()=>void;onHistory?:(direction:'up'|'down')=>void;inputRef?:React.RefObject<HTMLInputElement>;outputRef?:React.RefObject<HTMLDivElement>}){
  const internalInput=useRef<HTMLInputElement>(null),inputRef=externalInput||internalInput,[copied,setCopied]=useState(false)
  return <div className="overflow-hidden rounded-lg border border-border bg-well">
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5"><span className="flex min-w-0 items-center gap-2 truncate font-mono text-xs text-muted-foreground"><Terminal className="h-3.5 w-3.5"/>{title}</span><div className="flex items-center gap-3 text-[11px] text-muted-foreground"><span className="flex items-center gap-1.5"><span className={cn('h-1.5 w-1.5 rounded-full',running?'animate-pulse bg-status-building':'bg-status-ready')}/>{running?'running':'ready'}</span>{outputText&&<button onClick={async()=>{await navigator.clipboard.writeText(outputText);setCopied(true);setTimeout(()=>setCopied(false),1200)}} className="flex items-center gap-1 hover:text-foreground">{copied?<Check className="h-3 w-3"/>:<Copy className="h-3 w-3"/>}{copied?'Copied':'Copy'}</button>}{outputText&&!running&&<button onClick={()=>{onClear();inputRef.current?.focus()}} className="hover:text-foreground">Clear</button>}</div></div>
    <div ref={outputRef} className="h-[480px] cursor-text overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground/85" onClick={()=>inputRef.current?.focus()}>
      {output}<div className="mt-1 flex min-h-7 items-start gap-2 text-[13px] leading-7"><span className="shrink-0 text-syn-cyan max-w-[50%] break-all">{cwd}</span><span className="shrink-0 font-semibold text-foreground">&gt;</span>
      <input ref={inputRef} className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] leading-7 text-foreground caret-current outline-none" aria-label="Console command" value={command} onChange={e=>onCommand(e.target.value)} readOnly={running||disabled} placeholder={disabled?'Console unavailable':running?'Command is running…':''} autoComplete="off" spellCheck={false} onKeyDown={e=>{
        if(e.ctrlKey&&e.key.toLowerCase()==='c'&&running){e.preventDefault();onStop()}
        else if(e.ctrlKey&&e.key.toLowerCase()==='l'){e.preventDefault();onClear()}
        else if(e.ctrlKey&&e.key.toLowerCase()==='u'||e.key==='Escape'){e.preventDefault();onCommand('')}
        else if(e.key==='Tab'&&!running&&onComplete){e.preventDefault();onComplete()}
        else if((e.key==='ArrowUp'||e.key==='ArrowDown')&&onHistory){e.preventDefault();onHistory(e.key==='ArrowUp'?'up':'down')}
        else if(e.key==='Enter'&&!running&&!disabled&&command.trim()){e.preventDefault();onRun()}
      }}/>{running&&<button onClick={e=>{e.stopPropagation();onStop()}} className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md bg-red-500/15 px-2.5 py-1 text-xs leading-5 text-red-300"><Square className="h-3 w-3"/>Stop</button>}</div>
    </div><p className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground">{onComplete?'Tab completes · ':''}{onHistory?'↑↓ history · ':''}Ctrl+C stops · Ctrl+L clears</p>
  </div>
}
