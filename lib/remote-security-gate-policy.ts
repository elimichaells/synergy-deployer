export function remoteGateState(value:Record<string,any>|null|undefined) {
  const off=value?.until==='infinity'||Date.parse(value?.until)>Date.now()
  return off?{off:true,indefinite:value!.until==='infinity',until:value!.until==='infinity'?null:value!.until,reason:value!.reason,by:value!.by||null,at:value!.at}:{off:false,indefinite:false,until:null,reason:null,by:null,at:null}
}
