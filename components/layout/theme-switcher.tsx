'use client'

import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, Monitor, Moon, Sun } from 'lucide-react'

type Theme = 'light' | 'dark' | 'system'
const key = 'synergy:theme'

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme | null>(null)
  useEffect(() => {
    try { const value = localStorage.getItem(key); setTheme(value === 'dark' || value === 'system' ? value : 'light') } catch { setTheme('light') }
  }, [])
  useEffect(() => {
    if (!theme) return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.documentElement.classList.toggle('dark', dark)
    }
    apply(); media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  function choose(value: Theme) { setTheme(value); try { localStorage.setItem(key, value) } catch { /* Theme still works for this visit. */ } }
  const Icon = theme === 'dark' ? Moon : theme === 'system' ? Monitor : Sun
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><button type="button" aria-label="Appearance" title="Appearance" className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"><Icon className="h-4 w-4" /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={8} className="z-50 w-44 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
      <DropdownMenu.Label className="px-2 py-2 text-xs text-muted-foreground">Appearance</DropdownMenu.Label>
      {([{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Monitor }] as const).map(item => <DropdownMenu.Item key={item.value} onSelect={() => choose(item.value)} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent"><item.icon className="h-4 w-4" /><span className="flex-1">{item.label}</span>{theme === item.value && <Check className="h-3.5 w-3.5 text-primary" />}</DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
