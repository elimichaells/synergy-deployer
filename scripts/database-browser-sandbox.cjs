'use strict';
// phpMyAdmin's optional preference/history storage assumes a normal origin.
// Give this document bounded, ephemeral storage without granting Manager's
// origin, cookies or browser storage to a connected server's HTML.
function isolatedStorage(){
  const make=()=>{
    const values=new Map();
    const methods={getItem:key=>values.get(String(key))??null,removeItem:key=>{values.delete(String(key))},clear:()=>values.clear(),key:index=>[...values.keys()][Number(index)]??null,
      setItem:(key,value)=>{key=String(key);value=String(value);let size=key.length+value.length;for(const[k,v]of values)if(k!==key)size+=k.length+v.length;if(size>262144||!values.has(key)&&values.size>=1000)throw new DOMException('Private browser storage is full','QuotaExceededError');values.set(key,value)}};
    return new Proxy(Object.create(null),{get:(_,key)=>key==='length'?values.size:typeof key==='string'&&Object.hasOwn(methods,key)?methods[key]:values.get(key),set:(_,key,value)=>{methods.setItem(key,value);return true},deleteProperty:(_,key)=>{values.delete(key);return true},ownKeys:()=>[...values.keys()],getOwnPropertyDescriptor:(_,key)=>values.has(key)?{configurable:true,enumerable:true,writable:true,value:values.get(key)}:undefined});
  };
  for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{value:make(),configurable:false});
  const cookies=new Map();Object.defineProperty(document,'cookie',{configurable:false,get:()=>[...cookies].map(([k,v])=>k+'='+v).join('; '),set:value=>{const match=String(value).match(/^([^=;\s]{1,100})=([^;]{0,8192})/);if(!match)return;if(cookies.has(match[1])||cookies.size<30)cookies.set(match[1],match[2])}});
}
module.exports='<script>('+isolatedStorage.toString()+')();</script>';
