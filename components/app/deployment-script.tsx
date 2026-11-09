'use client'
export function DeploymentScript({value,onChange,disabled}:{value:string;onChange:(value:string)=>void;disabled?:boolean}){
  return <label className="field-label">Deployment script <span className="font-normal text-muted-foreground">Replaces install and build when set</span>
    <textarea rows={10} disabled={disabled} className="control-textarea min-h-56 bg-well font-mono" value={value} onChange={event=>onChange(event.target.value)} placeholder={'composer install --no-interaction --prefer-dist --optimize-autoloader\nphp artisan migrate --force\nnpm ci\nnpm run build'} spellCheck={false}/>
    <span className="text-xs font-normal text-muted-foreground">Commands run one line at a time from the candidate directory and stop at the first failure. $BRANCH is the deployed branch. Database migrations are not reversed by release rollback.</span>
  </label>
}
