export type Kind='node'|'storage'|'network'|'guest'|'project'|'container'|'volume'|'endpoint'|'backup-job';
export interface Entity{id:string;kind:Kind;label:string;parent?:string;status?:'ok'|'warning'|'critical'|'unknown';metadata?:Record<string,unknown>}
export interface Relation{id:string;source:string;target:string;kind:string}
export interface Topology{generatedAt:string;entities:Entity[];relations:Relation[]}
export type IssueState='pending'|'open'|'resolved'|'suppressed';
export interface Issue{id:string;entityId:string;code:string;severity:'warning'|'critical';state:IssueState;message:string;failures:number;fingerprint:string;openedAt?:string;updatedAt:string;resolvedAt?:string}
