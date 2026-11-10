'use strict';
function projectQuickCommands(type) {
  if (type === 'go') return ['go version', 'go mod download', 'go test ./...', 'go list ./...']
  if (type === 'laravel') return ['php --version', 'composer install --no-interaction', 'php artisan about', 'php artisan migrate:status', 'php artisan schedule:list']
  return ['node --version', 'npm ci --include=dev', 'npm run build', 'npm outdated']
}

function consoleGitArguments(command) {
  if (!/^git(?:\.exe)?\s+(?:fetch|pull|push|ls-remote)(?:\s|$)/i.test(command.trim())) return null
  if (/[&|<>;`$%\r\n\x00]/.test(command)) throw new Error('Run Git network commands separately, without shell operators or variable expansion, to use the saved Git connection.')
  const parts = []
  let current = '', quote = '', started = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else if (/\s/.test(char)) {
      if (started) { parts.push(current); current = ''; started = false }
    } else { current += char; started = true }
  }
  if (quote) throw new Error('Close the quote in the Git command.')
  if (started) parts.push(current)
  const args = parts.slice(1)
  // These options execute a caller-selected helper with the credential environment.
  if (args.slice(1).some(arg => (arg.startsWith('--') && arg !== '--' && ['--upload-pack', '--receive-pack', '--exec'].some(option => option.startsWith(arg.split('=')[0])))
    || (args[0] === 'ls-remote' && /^-u/.test(arg)) || (args[0] === 'push' && /^-e/.test(arg)))) {
    throw new Error('Custom Git transport executables cannot use the saved Git connection.')
  }
  return args
}

function completeCommand(command,entries,commands,windows) {
  const token=command.match(/(?:^|\s)([^\s"']*)$/)?.[1]||'',start=command.length-token.length;
  const names=windows?['cd','clear','cls','Get-ChildItem','Get-Content','Get-Location','pwd']:['cd','clear','ls','cat','pwd'];
  const source=start===0?[...names,...commands.map(value=>value.split(/\s+/)[0])]:entries;
  const key=value=>windows?value.toLowerCase():value;
  const matches=[...new Set(source)].filter(entry=>key(entry).startsWith(key(token)));
  if(!matches.length)return {command,matches:[]};
  const common=matches.reduce((prefix,entry)=>{let i=0;while(i<prefix.length&&i<entry.length&&key(prefix[i])===key(entry[i]))i++;return prefix.slice(0,i)});
  return {command:matches.length===1||common.length>token.length?command.slice(0,start)+(matches.length===1?matches[0]:common):command,matches};
}
function consoleInfo(value) {
  if(!value||typeof value!=='object'||!Array.isArray(value.entries)||value.entries.length>500||!value.scripts||typeof value.scripts!=='object'||Array.isArray(value.scripts)||Object.keys(value.scripts).length>100||JSON.stringify(value).length>80000)throw Error('Invalid console information');
  if(value.entries.some(entry=>typeof entry!=='string'||entry.length>256||/[\x00-\x1f]/.test(entry)))throw Error('Invalid console entries');
  const scripts=Object.fromEntries(Object.entries(value.scripts).filter(([key,command])=>/^[A-Za-z0-9_.:-]{1,100}$/.test(key)&&typeof command==='string'&&command.length<=500));
  return {entries:value.entries,scripts};
}
module.exports={projectQuickCommands,consoleGitArguments,completeCommand,consoleInfo};
