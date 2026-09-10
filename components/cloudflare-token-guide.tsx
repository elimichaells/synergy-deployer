import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CloudflareTokenGuide() {
  return <section aria-labelledby="cloudflare-token-guide" className="space-y-4 border-y border-border py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id="cloudflare-token-guide" className="text-sm font-semibold">Create a scoped token</h3>
      <Button variant="outline" size="sm" asChild>
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" title="Open Cloudflare API tokens in a new tab">
          Cloudflare API tokens<ArrowUpRight className="ml-2 h-4 w-4 shrink-0" aria-hidden="true" />
        </a>
      </Button>
    </div>
    <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
      <li>Sign in to Cloudflare, then choose <strong className="font-medium text-foreground">Create Token</strong>. Under <strong className="font-medium text-foreground">Custom token</strong>, select <strong className="font-medium text-foreground">Get started</strong> and name it Manager.</li>
      <li>
        Add these permissions, selecting <strong className="font-medium text-foreground">Zone</strong> as the category for each row.
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">Required Cloudflare zone permissions</caption>
          <thead><tr className="border-b border-border"><th scope="col" className="py-2 font-medium">Permission</th><th scope="col" className="py-2 font-medium">Access</th></tr></thead>
          <tbody className="text-foreground">
            <tr><th scope="row" className="py-1.5 font-normal">Zone</th><td className="py-1.5">Read</td></tr>
            <tr><th scope="row" className="py-1.5 font-normal">DNS</th><td className="py-1.5">Edit</td></tr>
            <tr><th scope="row" className="py-1.5 font-normal">Zone Settings</th><td className="py-1.5">Edit</td></tr>
          </tbody>
        </table>
      </li>
      <li>Under <strong className="font-medium text-foreground">Zone Resources</strong>, choose <strong className="font-medium text-foreground">Include / Specific zone</strong> and select each domain Manager should manage. Avoid granting access to all zones.</li>
      <li>Choose <strong className="font-medium text-foreground">Continue to summary</strong>, review the scope, then <strong className="font-medium text-foreground">Create Token</strong>. Copy the token into the field below; Cloudflare shows the secret only once.</li>
    </ol>
    <p className="text-xs text-muted-foreground">Use a user API token, not a Global API Key or your Cloudflare password. Zone Settings Edit permits zone-wide settings changes, including SSL mode.</p>
    <a href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
      Cloudflare token guide<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  </section>
}
