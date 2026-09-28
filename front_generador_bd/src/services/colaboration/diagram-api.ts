export interface DiagramApi {
  getGraph(): any;
  getJoint(): any;
  createUmlClass(payload: any, remote?: boolean): any;
  // crea y añade una relación tipada
  buildLinkForRemote?(sourceId?: string, targetId?: string): any;
  // NUEVO: para colaboración
  createRelationship?(sourceId: string, targetId: string, remote?: boolean): any;
  createTypedRelationship?(sourceId: string, targetId: string, type: string, remote?: boolean): any;
  getEdition?(): any;
  getPaper?(): any;
  loadFromJson(json: any, isStorageLoad?: boolean): void;
  exportToJson(): any;
}
