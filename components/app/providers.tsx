import { cn } from '@/lib/utils'

export type Provider = 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver' | 'mongodb' | 'redis'

export const providerMeta: Record<Provider, { label: string; short: string; color: string }> = {
  postgresql: { label: 'PostgreSQL', short: 'PG', color: 'bg-[#336791]' },
  mysql: { label: 'MySQL', short: 'My', color: 'bg-[#00758f]' },
  mariadb: { label: 'MariaDB', short: 'Ma', color: 'bg-[#a4775b]' },
  sqlserver: { label: 'SQL Server', short: 'MS', color: 'bg-[#a91d22]' },
  mongodb: { label: 'MongoDB', short: 'Mo', color: 'bg-[#13aa52]' },
  redis: { label: 'Redis', short: 'Re', color: 'bg-[#d82c20]' },
}

export function ProviderLogo({ provider, size = 'md' }: { provider: Provider; size?: 'sm' | 'md' }) {
  const meta = providerMeta[provider] || { short: 'DB', color: 'bg-neutral-700' }
  return <span className={cn('flex shrink-0 items-center justify-center rounded-md font-mono font-semibold text-white', meta.color, size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-9 w-9 text-xs')}>{meta.short}</span>
}
