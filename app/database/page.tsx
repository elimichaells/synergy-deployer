import { redirect } from 'next/navigation'

/** The explorer moved into Storage: each database has its own page, and unused ones are under Servers. */
export default function DatabaseRedirect() {
  redirect('/storage?tab=servers')
}
