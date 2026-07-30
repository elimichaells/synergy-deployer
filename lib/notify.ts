import { getSetting } from '@/lib/settings'

export type NotifyLevel = 'success' | 'error' | 'warning' | 'info'

const LEVEL_COLORS: Record<NotifyLevel, number> = {
  success: 0x22c55e,
  error: 0xef4444,
  warning: 0xf59e0b,
  info: 0x38bdf8,
}

const LEVEL_EMOJI: Record<NotifyLevel, string> = {
  success: '✅',
  error: '🚨',
  warning: '⚠️',
  info: 'ℹ️',
}

export interface NotifyField {
  name: string
  value: string
}

/**
 * Send a notification to the configured webhook (Settings → NOTIFY_WEBHOOK_URL).
 * Payload shape is auto-detected: Discord, Slack, or generic JSON POST.
 * Never throws — notification failure must not affect the operation itself.
 */
export async function sendNotification(
  title: string,
  message: string,
  level: NotifyLevel = 'info',
  fields: NotifyField[] = []
): Promise<boolean> {
  try {
    const url = await getSetting('NOTIFY_WEBHOOK_URL')
    if (!url || !url.startsWith('http')) return false

    let payload: Record<string, unknown>

    if (url.includes('discord.com/api/webhooks') || url.includes('discordapp.com/api/webhooks')) {
      payload = {
        embeds: [{
          title: `${LEVEL_EMOJI[level]} ${title}`,
          description: message,
          color: LEVEL_COLORS[level],
          fields: fields.map((f) => ({ name: f.name, value: f.value, inline: true })),
          timestamp: new Date().toISOString(),
        }],
      }
    } else if (url.includes('hooks.slack.com')) {
      const fieldLines = fields.map((f) => `*${f.name}:* ${f.value}`).join('\n')
      payload = {
        text: `${LEVEL_EMOJI[level]} *${title}*\n${message}${fieldLines ? `\n${fieldLines}` : ''}`,
      }
    } else {
      // Generic JSON webhook (n8n, Zapier, custom endpoints, Telegram bots via relay, …)
      payload = {
        title,
        message,
        level,
        fields,
        timestamp: new Date().toISOString(),
        source: 'nextops-manager',
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch (err) {
    console.error('[notify] failed to send notification:', err)
    return false
  }
}

function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export async function notifyDeploy(options: {
  projectName: string
  status: 'success' | 'failed'
  trigger: string
  durationMs: number
  commitSha?: string | null
  error?: string
}) {
  const { projectName, status, trigger, durationMs, commitSha, error } = options
  const fields: NotifyField[] = [
    { name: 'Trigger', value: trigger },
    { name: 'Duration', value: formatDuration(durationMs) },
  ]
  if (commitSha) fields.push({ name: 'Commit', value: commitSha.slice(0, 7) })

  if (status === 'success') {
    await sendNotification(`Deployed ${projectName}`, `Deployment completed successfully.`, 'success', fields)
  } else {
    await sendNotification(
      `Deploy failed: ${projectName}`,
      error || 'Deployment failed — check the logs in the manager.',
      'error',
      fields
    )
  }
}
