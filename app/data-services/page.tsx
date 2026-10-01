import { redirect } from 'next/navigation'

/** Database servers and migrations moved into Storage. */
export default function DataServicesRedirect() {
  redirect('/storage?tab=servers')
}
