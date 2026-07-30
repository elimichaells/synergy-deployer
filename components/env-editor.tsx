'use client'

import { useRef, type UIEvent } from 'react'

/**
 * Color-coded .env editor.
 *
 * A transparent-text <textarea> captures input while a perfectly aligned <pre>
 * behind it renders the syntax-highlighted tokens. Scroll positions are synced
 * so the two layers always line up.
 */

interface EnvEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

function highlightLine(line: string, key: number) {
  // Full-line or trailing comment handling is done per segment below
  const trimmed = line.trimStart()

  // Blank line
  if (trimmed === '') {
    return <span key={key}>{'\n'}</span>
  }

  // Comment line
  if (trimmed.startsWith('#')) {
    return (
      <span key={key} className="text-zinc-500 italic">
        {line}
        {'\n'}
      </span>
    )
  }

  // KEY=VALUE (with optional `export ` prefix)
  const match = line.match(/^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/)
  if (!match) {
    // Unparseable line — flag it subtly so typos stand out
    return (
      <span key={key} className="text-rose-400/80">
        {line}
        {'\n'}
      </span>
    )
  }

  const [, indent, exportKw, envKey, equals, rawValue] = match

  // Split a trailing comment off the value (only when preceded by whitespace,
  // so values like `secret#123` are not cut)
  let value = rawValue
  let comment = ''
  const commentMatch = rawValue.match(/^(.*?)(\s+#.*)$/)
  if (commentMatch && !/^["'].*["']$/.test(rawValue.trim())) {
    value = commentMatch[1]
    comment = commentMatch[2]
  }

  let valueClass = 'text-emerald-300'
  const v = value.trim()
  if (/^(["']).*\1$/.test(v)) {
    valueClass = 'text-amber-300' // quoted string
  } else if (/^-?\d+(\.\d+)?$/.test(v)) {
    valueClass = 'text-violet-300' // number
  } else if (/^(true|false|yes|no|on|off)$/i.test(v)) {
    valueClass = 'text-orange-300' // boolean-ish
  } else if (/^(https?|postgres(ql)?|mysql|redis|mongodb(\+srv)?|amqp|ftp):\/\//i.test(v)) {
    valueClass = 'text-cyan-300' // connection URL
  } else if (v === '') {
    valueClass = 'text-zinc-600'
  }

  return (
    <span key={key}>
      {indent}
      {exportKw && <span className="text-purple-400">{exportKw}</span>}
      <span className="text-sky-300 font-medium">{envKey}</span>
      <span className="text-zinc-500">{equals}</span>
      <span className={valueClass}>{value || ' '}</span>
      {comment && <span className="text-zinc-500 italic">{comment}</span>}
      {'\n'}
    </span>
  )
}

export function EnvEditor({ value, onChange, placeholder, className = '', disabled }: EnvEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)

  const syncScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (highlightRef.current) {
      highlightRef.current.scrollTop = e.currentTarget.scrollTop
      highlightRef.current.scrollLeft = e.currentTarget.scrollLeft
    }
  }

  const lines = value.split('\n')
  const sharedClasses =
    'absolute inset-0 h-full w-full whitespace-pre font-mono text-xs leading-5 p-3 overflow-auto'

  return (
    <div className={`relative rounded-lg border border-white/10 bg-black/40 focus-within:ring-1 focus-within:ring-sky-500/60 focus-within:border-sky-500/40 transition-shadow ${className}`}>
      {/* Highlight layer */}
      <pre ref={highlightRef} aria-hidden className={`${sharedClasses} pointer-events-none m-0 scrollbar-none`}>
        {lines.map((line, i) => highlightLine(line, i))}
        {/* trailing space keeps the last line's height when the textarea adds one */}
        {' '}
      </pre>

      {/* Input layer (transparent text, visible caret) */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        className={`${sharedClasses} resize-none bg-transparent text-transparent caret-sky-300 placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed`}
      />
    </div>
  )
}
