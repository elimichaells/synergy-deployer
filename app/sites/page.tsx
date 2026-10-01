import { redirect } from 'next/navigation'

/** The flat app list is now the Apps view of Projects. */
export default function SitesRedirect() {
  redirect('/projects?view=apps')
}
