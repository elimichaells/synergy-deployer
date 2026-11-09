import type {Client} from 'pg';
export interface OwnedObject {kind:string;schema:string;name:string;args?:string|null;owner:string;owner_is_super:boolean}
export function inventory(client:Client):Promise<OwnedObject[]>;
export function quoteIdent(value:string):string;
export function ownershipStatement(object:OwnedObject,owner:string):string;
