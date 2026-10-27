import { ArrowRight, Boxes, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
export function InfrastructureOverview({ projectsHref, items, facts = {} }: { projectsHref: string; items: { href: string; label: string; description: string; icon: LucideIcon }[]; facts?: Record<string, string | null> }) {
  return <>
      <div className="mb-6 flex items-start gap-3 rounded-xl border border-border bg-card p-5">
        <Boxes className="mt-0.5 h-5 w-5 shrink-0 text-syn-violet" />
        <div className="text-sm">
          <p className="font-medium">Looking for an app&apos;s database or domain?</p>
          <p className="mt-1 text-muted-foreground">Open its project: databases, domains, jobs and deployments for each product live there. This area is for administrators managing the server itself.</p>
          <Link href={projectsHref} className="mt-2 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">Go to projects<ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map(item => (
          <Link key={item.href} href={item.href} className="syn-tile flex items-start gap-4 p-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-well"><item.icon className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.description}</span>
              {facts[item.href] && <span className="mt-2 block text-xs text-foreground/80">{facts[item.href]}</span>}
            </span>
            <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
  </>
}
