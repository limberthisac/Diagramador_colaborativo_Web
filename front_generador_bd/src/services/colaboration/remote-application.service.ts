// services/colaboration/remote-application.service.ts
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class RemoteApplicationService {
  applyAddClass(
    id: string,
    payload: any,
    graph: any,
    createUmlClass: (payload: any) => any // factory local
  ) {
    if (graph.getCell(id)) return;
    const el = createUmlClass(payload);
    el.set('id', id); // forzar id remoto
  }

  applyEditText(graph: any, id: string, field: 'name'|'attributes'|'methods', value: string) {
    const m = graph.getCell(id);
    if (!m) return;
    const map = {
      name: '.uml-class-name-text',
      attributes: '.uml-class-attrs-text',
      methods: '.uml-class-methods-text'
    } as const;
    m.attr(`${map[field]}/text`, value);
  }

  applyMove(graph: any, id: string, x: number, y: number) {
    const m = graph.getCell(id);
    if (m) m.position(x, y);
  }

  applyResize(graph: any, id: string, w: number, h: number) {
    const m = graph.getCell(id);
    if (m) m.resize(w, h);
  }

  applyAddLink(
    linkId: string,
    sourceId: string,
    targetId: string,
    graph: any,
    buildLink: (s?: string, t?: string) => any
  ) {
    if (graph.getCell(linkId)) return;
    const link = buildLink(sourceId, targetId);
    link.set('id', linkId);
    graph.addCell(link);
  }

  applyEditLabel(graph: any, linkId: string, index: number, text: string) {
    const link = graph.getCell(linkId);
    if (!link) return;
    link.label(index, { ...link.label(index), attrs: { text: { text } } });
  }

  applyDelete(graph: any, id: string) {
    const m = graph.getCell(id);
    if (m) m.remove();
  }
}
