import { Injectable } from '@angular/core';
import { P2PService } from './p2p.service';
import { DiagramApi } from './diagram-api';
import { BackupService } from '../exports/backup.service';

type Op = 
  | { t: 'add_class'; id: string; payload: any }
  | { t: 'edit_text'; id: string; field: 'name' | 'attributes' | 'methods'; value: string }
  | { t: 'move'; id: string; x: number; y: number }
  | { t: 'resize'; id: string; w: number; h: number }
  | { t: 'add_link'; id: string; sourceId: string; targetId: string; payload?: any }
  | { t: 'edit_label'; linkId: string; index: number; text: string }
  | { t: 'add_label'; linkId: string; index: number; label: any }
  | { t: 'del_label'; linkId: string; index: number }
  | { t: 'move_label'; linkId: string; index: number; position: { distance: number; offset?: number } }
  | { t: 'move_link'; id: string; sourceId: string; targetId: string }
  | { t: 'update_vertices'; id: string; vertices: any[] }
  | { t: 'delete'; id: string }
  | { t: 'request_full_state' }
  /** `replace` pisa el diagrama del receptor en vez de sumarle lo que llega.
   *  Lo usa la importación de XMI; sin él, importar sobre una sala con trabajo
   *  dejaba a cada quien con una mezcla distinta. */
  | { t: 'full_state'; payload: any; replace?: boolean };

@Injectable({ providedIn: 'root' })
export class CollaborationService {
  private api?: DiagramApi;
  private ready = false;
  constructor(
    private p2p: P2PService,
    private backup: BackupService
  ) {}

  registerDiagramApi(api: DiagramApi) {
    this.api = api;
  }

  init(roomId: string) {
    this.p2p.onData = (_: string | undefined, data: Op) => {
      if (!this.api?.getGraph()) return;
      this.applyRemoteOp(data);
    };
    this.p2p.init(roomId);
    this.ready = true;
    //this.broadcast({ t: 'request_full_state' });
    setTimeout(() => {
      if (!this.api?.getGraph()?.getCells()?.length) {
        console.log('[Collab] Nadie respondió, cargo backup de BD...');
        this.backup.getBackup(roomId).subscribe({
          next: (snapshot) => {
            if (snapshot) this.api!.loadFromJson(snapshot, true);
          },
          error: (err) => console.error('[Collab] Error obteniendo backup', err)
        });
      }
    }, 3000);
  }

  broadcast(op: Op) {
    if (!this.ready) return;
    this.p2p.sendToAll(op);
  }

  closeSocketRTC() {
    this.p2p.closeSocketRTC();
    this.ready = false;
  }

  private applyRemoteOp(op: Op) {
    try {
      const graph = this.api!.getGraph();
      const joint = this.api!.getJoint();
      switch (op.t) {
        case 'add_class': {
          if (graph.getCell(op.id)) break;
          this.api!.createUmlClass({ ...op.payload, id: op.id }, true);
          break;
        }
        case 'edit_text': {
          const m = graph.getCell(op.id);
          if (!m) break;
          const map = {
            name: '.uml-class-name-text',
            attributes: '.uml-class-attrs-text',
            methods: '.uml-class-methods-text',
          } as const;

          let val = op.value;
          if (Array.isArray(val)) {
             val = val.join('\n');
          }

          m.attr(`${map[op.field]}/text`, val);
          m.set(op.field, val, { collab: true });
          
          if (typeof m.updateRectangles === 'function') {
            m.updateRectangles();
          }

          if (!this.api || !this.api.getEdition) {
            console.warn('[Collab] API no soporta getEdition');
            break;
          }
          // 🔴 Forzar auto-resize en receptor
          this.api?.getEdition()?.scheduleAutoResize(m, this.api!.getPaper?.() ?? null);
          break;
        }


        case 'move': {
          const m = graph.getCell(op.id);
          if (!m) break;
          m.position(op.x, op.y);
          break;
        }
        case 'resize': {
          const m = graph.getCell(op.id);
          if (!m) break;
          m.resize(op.w, op.h);
          break;
        }
        case 'add_link': {
          if (graph.getCell(op.id)) break;

          const type = op.payload?.type || 'association';
          
          if (!this.api || !this.api.createTypedRelationship) {
            console.warn('[Collab] API no soporta createTypedRelationship');
            break;
          }
          // construir SIN agregar (remote=true)
          const link = this.api!.createTypedRelationship(op.sourceId, op.targetId, type, true);

          // setear ID, tipo y labels ANTES de insertar
          link.set('id', op.id);
          link.set('relationType', type);
          if (op.payload?.labels) link.set('labels', op.payload.labels);

          // agregar una única vez, marcado como remoto
          graph.addCell(link, { collab: true });
          break;
        }

        case 'move_link': {
          const link = graph.getCell(op.id);
          if (!link) break;
          link.set('source', { id: op.sourceId }, { collab: true });
          link.set('target', { id: op.targetId }, { collab: true });
          break;
        }

        case 'update_vertices': {
          const link = graph.getCell(op.id);
          if (!link) break;
          link.set('vertices', op.vertices, { collab: true });
          break;
        }


        case 'add_label': {
          const link = graph.getCell(op.linkId);
          if (!link) break;

          // aseguramos markup para compatibilidad
          const label = {
            ...op.label,
            markup: op.label.markup || [{ tagName: 'text', selector: 'text' }]
          };

          link.insertLabel(op.index, label);
          link.set('labels', link.labels());
          link.trigger('change:labels', link, link.labels());
          break;
        }

        case 'edit_label': {
          const link = graph.getCell(op.linkId);
          if (!link) break;
          const labels = link.labels() || [];
          if (op.index < 0 || op.index >= labels.length) break;

          const lbl = labels[op.index];
          link.label(op.index, {
            ...lbl,
            attrs: { ...lbl.attrs, text: { ...lbl.attrs?.text, text: op.text } },
            markup: lbl.markup || [{ tagName: 'text', selector: 'text' }]
          });
          link.set('labels', link.labels());
          link.trigger('change:labels', link, link.labels());
          break;
        }

        case 'move_label': {
          const link = graph.getCell(op.linkId);
          if (!link) break;
          const labels = link.labels() || [];
          if (op.index < 0 || op.index >= labels.length) break;

          const lbl = labels[op.index];
          link.label(op.index, {
            ...lbl,
            position: op.position,
            markup: lbl.markup || [{ tagName: 'text', selector: 'text' }]
          });
          link.set('labels', link.labels());
          link.trigger('change:labels', link, link.labels());
          break;
        }

        case 'del_label': {
          const link = graph.getCell(op.linkId);
          if (!link) break;
          link.removeLabel(op.index);
          link.set('labels', link.labels()); 
          link.trigger('change:labels', link, link.labels());
          break;
        }


        case 'delete': {
          const m = graph.getCell(op.id);
          if (m) m.remove({ collab: true }); // <- importante para no re-emitir
          break;
        }

        case 'request_full_state': {
          const cells = this.api?.getGraph()?.getCells();
          if (cells && cells.length > 0) {
            const snapshot = this.api!.exportToJson();
            this.broadcast({ t: 'full_state', payload: snapshot });
          }
          break;
        }

        case 'full_state': {
          if (!this.api) break;
          if (op.replace) {
            // `{ collab: true }` es imprescindible: sin él, cada celda borrada
            // dispara el handler de `remove` del lienzo, que reemitiría un
            // `delete` por celda a toda la sala y además llamaría a la
            // validación por IA una vez por cada una.
            graph.clear({ collab: true });
          }
          this.api.loadFromJson(op.payload);
          break;
        }


      }
    } catch (err) {
      console.error('[Collab] applyRemoteOp error', op, err);
    }
  }
}
