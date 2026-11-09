interface Location {host:string;port:number;database:string;username:string;password?:string}
export function replacements(values:Record<string,string>,from:Location,to:Location&{password:string}):Record<string,string>;
export function rewrite(content:string,from:Location,to:Location&{password:string}):{content:string;changed:number;values:Record<string,string>};
export function parse(content:string):Record<string,string>;
export function hostKey(value:string):string;
