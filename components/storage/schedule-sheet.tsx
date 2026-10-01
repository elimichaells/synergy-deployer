'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'

export interface ScheduleValues {
  enabled: boolean; frequency: string; timeOfDay: string; timezone: string
  dayOfWeek: number; dayOfMonth: number; monthOfYear: number; retentionCount: number
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const timezones = ['UTC', 'Africa/Accra', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai']
export const defaultSchedule: ScheduleValues = { enabled: true, frequency: 'daily', timeOfDay: '03:00', timezone: 'UTC', dayOfWeek: 0, dayOfMonth: 1, monthOfYear: 1, retentionCount: 30 }

/** Edit when a database is backed up and how many backups are kept. */
export function ScheduleSheet({ serviceId, initial, open, onOpenChange, onSaved }: { serviceId: string; initial: ScheduleValues | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [values, setValues] = useState<ScheduleValues>(initial || defaultSchedule)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) { setValues(initial || defaultSchedule); setError('') } }, [open, initial])
  const set = <K extends keyof ScheduleValues>(key: K, value: ScheduleValues[K]) => setValues(current => ({ ...current, [key]: value }))

  const save = async () => {
    setSaving(true); setError('')
    try {
      const response = await fetch('/api/data/backups/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId, ...values }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The schedule could not be saved')
      onOpenChange(false); onSaved()
    } catch (err) { setError((err as Error).message) } finally { setSaving(false) }
  }

  return (
    <Sheet open={open} onOpenChange={next => { if (!saving) onOpenChange(next) }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Backup schedule</SheetTitle>
          <SheetDescription>Choose when this database is backed up and how many backups are kept. Older ones are deleted automatically.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-sm"><span>Automatic backups</span><Switch checked={values.enabled} onCheckedChange={checked => set('enabled', checked)} aria-label="Automatic backups" /></label>
          <label className="field-label">How often
            <select className="control-input" value={values.frequency} onChange={event => set('frequency', event.target.value)}>
              <option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option><option value="yearly">Every year</option>
            </select>
          </label>
          {values.frequency === 'weekly' && <label className="field-label">On<select className="control-input" value={values.dayOfWeek} onChange={event => set('dayOfWeek', Number(event.target.value))}>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
          {values.frequency === 'yearly' && <label className="field-label">Month<select className="control-input" value={values.monthOfYear} onChange={event => set('monthOfYear', Number(event.target.value))}>{months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>}
          {(values.frequency === 'monthly' || values.frequency === 'yearly') && <label className="field-label">Day of the month<input className="control-input" type="number" min={1} max={28} value={values.dayOfMonth} onChange={event => set('dayOfMonth', Number(event.target.value))} /></label>}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field-label">Time<input className="control-input" type="time" value={values.timeOfDay} onChange={event => set('timeOfDay', event.target.value)} /></label>
            <label className="field-label">Time zone<select className="control-input" value={values.timezone} onChange={event => set('timezone', event.target.value)}>{(timezones.includes(values.timezone) ? timezones : [values.timezone, ...timezones]).map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          </div>
          <label className="field-label">Backups to keep<input className="control-input" type="number" min={1} max={365} value={values.retentionCount} onChange={event => set('retentionCount', Number(event.target.value))} /></label>
          {error && <p role="alert" className="notice-error">{error}</p>}
          <Button className="w-full" onClick={() => void save()} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save schedule</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
