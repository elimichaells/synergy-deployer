export interface GridColumn { name: string; type: string }

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="italic text-zinc-600">NULL</span>
  if (typeof value === 'boolean') return <span className={value ? 'text-emerald-400' : 'text-orange-400'}>{String(value)}</span>
  if (typeof value === 'number') return <span className="text-violet-300">{String(value)}</span>
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return <span className="text-cyan-300" title={json}>{json.length > 120 ? `${json.slice(0, 120)}…` : json}</span>
  }
  const text = String(value)
  return <span title={text.length > 120 ? text : undefined}>{text.length > 120 ? `${text.slice(0, 120)}…` : text}</span>
}

/** A scrollable table of query or table rows. */
export function ResultsGrid({ columns, rows }: { columns: GridColumn[]; rows: Record<string, unknown>[] }) {
  if (columns.length === 0) return null
  return (
    <div className="overflow-auto rounded-lg border border-white/[0.08]">
      <table className="w-full min-w-max border-collapse text-left font-mono text-xs">
        <thead className="sticky top-0 bg-[#101318]">
          <tr>{columns.map(column => (
            <th key={column.name} className="whitespace-nowrap border-b border-white/10 px-3 py-2 font-semibold text-foreground">
              {column.name}<span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{column.type}</span>
            </th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-white/[0.05]">
          {rows.length === 0
            ? <tr><td colSpan={columns.length} className="px-3 py-8 text-center italic text-muted-foreground">No rows</td></tr>
            : rows.map((row, index) => (
              <tr key={index} className="transition-colors hover:bg-white/[0.03]">
                {columns.map(column => <td key={column.name} className="max-w-md truncate whitespace-nowrap px-3 py-1.5 text-[#c9cbd1]"><CellValue value={row[column.name]} /></td>)}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
