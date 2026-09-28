import { Injectable } from '@angular/core';
import { UmlClass } from '../../models/uml-class.model';
import { EditionService } from './edition.service';
import { v4 as uuid } from 'uuid';
import { CollaborationService } from '../colaboration/collaboration.service';
import { RemoteApplicationService } from '../colaboration/remote-application.service';
import { DiagramExportService, UmlExportDTO } from '../exports/diagram-export.service';
import { UmlValidationService } from '../colaboration/uml-validation.service';
import { BackupService } from '../exports/backup.service';

@Injectable({ providedIn: 'root' })
export class DiagramService {

  private joint: any;
  private graph: any;
  private paper: any;
  private selectedCell: any = null;
  private storageKey = '';
  private currentScale = 1; // escala inicial
  private minScale = 0.2;   // zoom out máximo
  private maxScale = 2;     // zoom in máximo
  private zoomStep = 0.1;   // incremento
  private pan = { x: 0, y: 0 };
  private isPanning = false;
  private lastPos = { x: 0, y: 0 };
  public clipboard: any = null;


  constructor(
    private edition: EditionService,
    private collab: CollaborationService,
    private exportService: DiagramExportService,
    private umlValidationService: UmlValidationService,
    private backup: BackupService,
  ) { }

  /**
   * Inicializa JointJS y configura el papel y grafo
   */
  async initialize(paperElement: HTMLElement, roomId: string): Promise<void> {
    try {
      // Cada sala empieza con la vista en su posición inicial.
      //
      // Este servicio es único para toda la aplicación y sobrevive al pasar de
      // una sala a otra: el grafo y el papel se crean de nuevo unas líneas más
      // abajo, pero el zoom, el desplazamiento y la selección son campos del
      // servicio y conservan lo que quedó de la sala anterior. Sin esto, quien
      // aleja el zoom para ver un diagrama grande entra a la sala siguiente
      // mirándola de lejos, y las clases nuevas parecen diminutas aunque tengan
      // el tamaño de siempre.
      //
      // Tiene que ir antes de crear el papel, porque más abajo se aplican estos
      // mismos valores con `paper.scale()` y `paper.translate()`.
      //
      // `selectedCell` entra en el mismo lote porque apunta a una celda del
      // grafo anterior, que ya no existe: dejarla haría que la primera pulsación
      // de Suprimir intentara borrar algo inexistente.
      this.currentScale = 1;
      this.pan = { x: 0, y: 0 };
      this.selectedCell = null;

      // Configura la clave de almacenamiento local
      this.storageKey = `diagram-${roomId}`;
      // Importamos JointJS
      this.joint = await import('jointjs');
      // Creamos el grafo
      this.graph = new this.joint.dia.Graph();
      // Creamos el papel/canvas
      this.paper = new this.joint.dia.Paper({
        el: paperElement,
        model: this.graph,
        width: 800,
        height: 600,
        gridSize: 10,
        drawGrid: true,
        interactive: { elementMove: true, addLinkFromMagnet: true },
        background: { color: '#f8f9fa' },
        defaultConnector: { name: 'rounded' },
        defaultLink: () => this.buildRelationship(),
        validateConnection: (cvS: any, _mS: any, cvT: any, _mT: any) => cvS !== cvT,
      });
      /**************************************************************************************************
       * ATAJOS DE TECLADO: copiar, pegar, duplicar, cortar
       ***************************************************************************************************/
      let clipboard: any = null;

      paperElement.addEventListener('keydown', (evt: KeyboardEvent) => {
        if (!this.selectedCell) return;
        if (evt.ctrlKey && evt.key === 'c') {
          // Copiar
          clipboard = this.copyUmlClass(this.selectedCell);
          console.log('Clase copiada');
          evt.preventDefault();
        }
        if (evt.ctrlKey && evt.key === 'v') {
          // Pegar
          if (clipboard) {
            this.pasteUmlClass(clipboard);
            console.log('Clase pegada');
          }
          evt.preventDefault();
        }
        if (evt.ctrlKey && evt.key === 'x') {
          // Cortar
          clipboard = this.copyUmlClass(this.selectedCell);
          this.deleteSelected();
          console.log('Clase cortada');
          evt.preventDefault();
        }
        if (evt.ctrlKey && evt.key === 'd') {
          // Duplicar
          const clone = this.copyUmlClass(this.selectedCell);
          this.pasteUmlClass(clone);
          console.log('Clase duplicada');
          evt.preventDefault();
        }
      });

      // Para que el canvas reciba los eventos de teclado
      paperElement.tabIndex = 0;
      paperElement.style.outline = 'none';
      paperElement.addEventListener('wheel', (evt: WheelEvent) => {
        if (evt.ctrlKey) { // solo cuando mantienes Ctrl
          evt.preventDefault();
          if (evt.deltaY < 0) {
            this.zoomIn();
          } else {
            this.zoomOut();
          }
        }
      });
      paperElement.addEventListener('mousedown', (evt: MouseEvent) => {
        if (evt.button === 2) { // botón derecho
          this.isPanning = true;
          this.lastPos = { x: evt.clientX, y: evt.clientY };
          paperElement.style.cursor = 'grab'; // cambia cursor a mano
          evt.preventDefault();
        }
      });

      paperElement.addEventListener('mousemove', (evt: MouseEvent) => {
        if (this.isPanning) {
          const dx = evt.clientX - this.lastPos.x;
          const dy = evt.clientY - this.lastPos.y;
          this.lastPos = { x: evt.clientX, y: evt.clientY };
          this.pan.x += dx;
          this.pan.y += dy;

          // mueve el paper
          this.paper.translate(this.pan.x, this.pan.y);
        }
      });

      paperElement.addEventListener('mouseup', () => {
        if (this.isPanning) {
          this.isPanning = false;
          paperElement.style.cursor = 'default'; // vuelve al normal
        }
      });

      // evita menú contextual al hacer click derecho
      paperElement.addEventListener('contextmenu', (evt: MouseEvent) => {
        evt.preventDefault();
      });

      /**************************************************************************************************
       * EVENTOS INTERACTIVOS EN EL PAPER (COLABORATIVO)
       ***************************************************************************************************/
      let pendingPos: { id: string; x: number; y: number } | null = null;
      const flushMove = () => {
        if (pendingPos) {
          this.collab.broadcast({ t: 'move', ...pendingPos });
          pendingPos = null;
        }
        requestAnimationFrame(flushMove);
      };
      requestAnimationFrame(flushMove);
      this.paper.on('element:pointermove', (view: any) => {
        const m = view.model;
        const p = m.position();
        pendingPos = { id: m.id, x: p.x, y: p.y };
      });
      this.paper.on('element:pointerup', (view: any) => {
        const m = view.model;
        const p = m.position();
        this.collab.broadcast({ t: 'move', id: m.id, x: p.x, y: p.y });
        pendingPos = null; // limpiar
      });


      this.graph.on('remove', (cell: any, _collection: any, opt: any = {}) => {
        if (opt?.collab) return; // viene de remoto, no re-emitir
        this.collab.broadcast({ t: 'delete', id: cell.id });
        const umlJson = this.exportService.export(this.graph);
        this.umlValidationService.validateModel(umlJson);
      });

      //👉 Difundir movimiento y redimensionamiento
      this.paper.on('element:pointerup', (view: any) => {
        const m = view.model;
        const p = m.position();
        this.collab.broadcast({ t: 'move', id: m.id, x: p.x, y: p.y });
      });
      // Si tienes resize interactivo, algo como:
      this.paper.on('element:resize:pointerup', (view: any) => {
        const m = view.model;
        const s = m.size();
        this.collab.broadcast({ t: 'resize', id: m.id, w: s.width, h: s.height });
      });
      // Difundir edición de etiquetas en links
      this.paper.on('link:label:pointerup', (linkView: any, evt: any, x: number, y: number) => {
        const model = linkView.model;
        const idx = this.getClickedLabelIndex(linkView, evt);
        if (idx == null) return;
        const lbl = model.label(idx);
        if (!lbl) return;
        this.collab.broadcast({ t: 'move_label', linkId: model.id, index: idx, position: lbl.position });
      });

      // 1) Emitir add_link al añadir un Link localmente
      this.graph.on('add', (cell: any, _col: any, opt: any = {}) => {
        if (opt?.collab) return;                 // si viene de remoto, no re-emitir
        if (!cell?.isLink?.()) return;

        const src = cell.get('source')?.id;
        const trg = cell.get('target')?.id;

        // Si todavía no tiene ambos extremos (ej. link "fantasma" al arrastrar),
        // dejamos que el handler de change:source/target haga el broadcast cuando se completen.
        if (!src || !trg) return;

        if (!cell.has('alreadyBroadcasted')) {
          cell.set('alreadyBroadcasted', true, { silent: true });
          const type = cell.get('relationType') || 'association';
          this.collab.broadcast({
            t: 'add_link',
            id: cell.id,
            sourceId: src,
            targetId: trg,
            payload: { type, labels: cell.get('labels') }
          });
        }
      });

      // 2) Respaldo: si el link se añadió sin extremos y luego se conectan
      this.graph.on('change:source change:target', (link: any, _val: any, opt: any = {}) => {
        if (!link?.isLink || opt?.collab) return;

        const src = link.get('source')?.id;
        const trg = link.get('target')?.id;
        if (!src || !trg) return;

        if (!link.has('alreadyBroadcasted')) {
          link.set('alreadyBroadcasted', true, { silent: true });
          const type = link.get('relationType') || 'association';
          this.collab.broadcast({
            t: 'add_link',
            id: link.id,
            sourceId: src,
            targetId: trg,
            payload: { type, labels: link.get('labels') }
          });
        } else {
          this.collab.broadcast({ t: 'move_link', id: link.id, sourceId: src, targetId: trg });
          const umlJson = this.exportService.export(this.graph);
          this.umlValidationService.validateModel(umlJson);
        }
      });


      /*COLABORACION DE RELACIONES*/
      // Problema de loop al mover relacion
      let pendingLabelMove: { linkId: string; index: number; position: { distance: number; offset?: number } } | null = null;
      const flushLabelMove = () => {
        if (pendingLabelMove) {
          this.collab.broadcast({ t: 'move_label', ...pendingLabelMove });
          pendingLabelMove = null;
        }
        requestAnimationFrame(flushLabelMove);
      };
      requestAnimationFrame(flushLabelMove);
      this.paper.on('link:label:pointermove', (linkView: any, evt: any) => {
        const model = linkView.model;
        const idx = this.getClickedLabelIndex(linkView, evt);
        if (idx == null) return;
        const lbl = model.label(idx);
        if (!lbl) return;
        pendingLabelMove = { linkId: model.id, index: idx, position: lbl.position };
      });
      // al soltar, enviamos una última confirmación
      this.paper.on('link:label:pointerup', (linkView: any, evt: any) => {
        const model = linkView.model;
        const idx = this.getClickedLabelIndex(linkView, evt);
        if (idx == null) return;
        const lbl = model.label(idx);
        if (!lbl) return;
        this.collab.broadcast({ t: 'move_label', linkId: model.id, index: idx, position: lbl.position });
        pendingLabelMove = null;
      });

      // 👉 Vertices
      this.graph.on('change:source change:target', (link: any, _val: any, opt: any = {}) => {
        if (!link?.isLink || opt?.collab) return;

        const src = link.get('source')?.id;
        const trg = link.get('target')?.id;
        if (!src || !trg) return;

        if (!link.has('alreadyBroadcasted')) {
          link.set('alreadyBroadcasted', true);

          // 👇 extraer el tipo del link si existe, si no, fallback
          const type = link.get('relationType') || 'association';

          this.collab.broadcast({
            t: 'add_link',
            id: link.id,
            sourceId: src,
            targetId: trg,
            payload: { type, labels: link.get('labels') }
          });
        } else {
          this.collab.broadcast({ t: 'move_link', id: link.id, sourceId: src, targetId: trg });
          const umlJson = this.exportService.export(this.graph);
          this.umlValidationService.validateModel(umlJson);
        }
      });

      // 3.3. CURVATURA / RUTEO DEL LINK (vértices)
      this.graph.off('change:vertices'); // evita doble registro si reinicializas
      this.graph.on('change:vertices', (link: any, _v: any, opt: any = {}) => {
        if (!link?.isLink || opt?.collab) return;
        this.collab.broadcast({ t: 'update_vertices', id: link.id, vertices: link.get('vertices') || [] });
      });

      // Problema de loop al mover clase
      let pendingResize: { id: string; w: number; h: number } | null = null;
      const flushResize = () => {
        if (pendingResize) {
          this.collab.broadcast({ t: 'resize', ...pendingResize });
          pendingResize = null;
        }
        requestAnimationFrame(flushResize);
      };
      requestAnimationFrame(flushResize);
      this.paper.on('element:resize', (view: any) => {
        const m = view.model;
        const s = m.size();
        pendingResize = { id: m.id, w: s.width, h: s.height };
      });
      this.paper.on('element:resize:pointerup', (view: any) => {
        const m = view.model;
        const s = m.size();
        this.collab.broadcast({ t: 'resize', id: m.id, w: s.width, h: s.height });
        pendingResize = null;
      });
      // Guardar en localStorage ante cualquier cambio
      this.graph.on('add remove change', () => {
        this.persist();
      });

      /**************************************************************************************************
       * EVENTOS INTERACTIVOS EN EL PAPER (MODICACION LOCAL)
       ***************************************************************************************************/
      //Seleccionar Una clase UML
      this.paper.on('cell:pointerclick', (cellView: any) => {
        if (this.selectedCell?.isElement?.()) {
          this.selectedCell.attr('.uml-outer/stroke', '#2196f3');
          this.selectedCell.attr('.uml-outer/stroke-width', 2);
          this.selectedCell.getPorts().forEach((p: any) => {
            this.selectedCell.portProp(p.id, 'attrs/circle/display', 'none');
          });
        }
        this.selectedCell = cellView.model;
        if (this.selectedCell?.isElement?.()) {
          this.selectedCell.attr('.uml-outer/stroke', '#ff9800');
          this.selectedCell.attr('.uml-outer/stroke-width', 2);
          this.selectedCell.getPorts().forEach((p: any) => {
            this.selectedCell.portProp(p.id, 'attrs/circle/display', 'block');
          });
        }
      });
      //👉 Deselect al hacer click en el fondo
      this.paper.on('blank:pointerclick', () => this.clearSelection());
      this.paper.on('cell:pointerdblclick', (cellView: any, _evt: any, x: number, y: number) => {
        this.clearSelection();
        const model = cellView.model;
        if (!model?.isElement?.()) return;
        // lee posiciones de separadores (puestas por autoResize)
        const bbox = model.getBBox();
        const relY = y - bbox.y;
        const sep1 = parseFloat(model.attr('.sep-name/y1')) || (this.edition.NAME_H + 0.5);
        const sep2 = parseFloat(model.attr('.sep-attrs/y1')) || (this.edition.NAME_H + 40 + 0.5);
        let field: 'name' | 'attributes' | 'methods' = 'methods';
        if (relY < sep1) field = 'name';
        else if (relY < sep2) field = 'attributes';
        this.edition.startEditing(model, this.paper, field, x, y, this.collab);
      });
      //👉 Doble clic en una relación para editar su etiqueta
      this.paper.on('link:pointerdblclick', (linkView: any, evt: MouseEvent, x: number, y: number) => {
        const model = linkView.model;
        if (model.get('name') !== 'Relacion') return;
        const labelIndex = this.getClickedLabelIndex(linkView, evt);
        if (labelIndex === null) return;
        const label = model.label(labelIndex);
        const currentValue = label?.attrs?.text?.text || '';
        this.edition.startEditingLabel(model, this.paper, labelIndex, currentValue, x, y, this.collab, this.graph);
        const node = linkView.findLabelNode(labelIndex) as SVGElement;
        if (node) {
          node.setAttribute('stroke', '#2196f3');
          node.setAttribute('stroke-width', '1');
        }
      });
      //👉 Clic derecho en una relación para añadir una nueva etiqueta
      this.paper.on('link:contextmenu', (linkView: any, evt: MouseEvent, x: number, y: number) => {
        evt.preventDefault();
        const model = linkView.model;
        const idx = this.getClickedLabelIndex(linkView, evt);

        if (idx != null) {
          // eliminar etiqueta
          model.removeLabel(idx);
          this.collab.broadcast({ t: 'del_label', linkId: model.id, index: idx });
          return;
        }

        // añadir etiqueta
        const newLabel = {
          position: { distance: linkView.getClosestPoint(x, y).ratio, offset: -10 },
          attrs: { text: { text: 'label', fill: '#333', fontSize: 12 } },
          markup: [{ tagName: 'text', selector: 'text' }]
        };
        model.appendLabel(newLabel);
        const newIndex = model.labels().length - 1;

        // 👇 difundir con el objeto completo
        this.collab.broadcast({
          t: 'add_label',
          linkId: model.id,
          index: newIndex,
          label: newLabel
        });
        this.edition.startEditingLabel(model, this.paper, newIndex, 'label', x, y, this.collab, this.graph);
      });

      // Aplicar zoom y pan inicial
      this.paper.scale(this.currentScale, this.currentScale);
      this.paper.translate(this.pan.x, this.pan.y);


      // 👉 inicializa colaboración **ANTES** de salir
      this.collab.registerDiagramApi({
        getGraph: () => this.graph,
        getJoint: () => this.joint,
        getEdition: () => this.edition,
        getPaper: () => this.paper,
        createUmlClass: (payload) => this.createUmlClass(payload),
        buildLinkForRemote: this.buildLinkForRemote,
        createRelationship: (sourceId, targetId, remote = false) =>
          this.createRelationship(sourceId, targetId, remote),

        // 👇 añade esto
        createTypedRelationship: (sourceId: string, targetId: string, type: string, remote = false) =>
          this.createTypedRelationship(sourceId, targetId, type, remote),

        loadFromJson: (json) => this.loadFromJson(json),
        exportToJson: () => this.exportService.export(this.graph),
      });

      // Obtener Persistencia Mediante LocalStorage
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        try {
          const json: UmlExportDTO = JSON.parse(saved);
          this.loadFromJson(json, false);
          //console.log('Lienzo restaurado desde localStorage');
        } catch (err) {
          console.warn('No se pudo restaurar lienzo:', err);
        }
      }

      this.collab.init(roomId);
      console.log('JointJS inicializado en room:', roomId);
      if (this.graph.getCells().length === 0) {
        this.collab.broadcast({ t: 'request_full_state' });
      }
      return Promise.resolve();
    } catch (error) {
      console.error('Error al inicializar JointJS:', error);
      return Promise.reject(error);
    }
  }

  /**************************************************************************************************
   * EDICIÓN DE RELACIONES
   ***************************************************************************************************/
  // Crea una relación entre dos elementos y la añade al grafo
  createRelationship(
    sourceId: string,
    targetId: string,
    remote: boolean = false
  ) {
    return this.createTypedRelationship(sourceId, targetId, 'association', remote);
  }


  // Construye una relación (link) con configuración por defecto
  private buildRelationship(sourceId?: string, targetId?: string) {
    return new this.joint.dia.Link({
      name: 'Relacion',
      relationType: 'association',    // 👈 tipo por defecto
      source: sourceId ? { id: sourceId } : undefined,
      target: targetId ? { id: targetId } : undefined,
      attrs: {
        '.connection': { stroke: '#333333', 'stroke-width': 2 },
        // Nace como asociación, así que va sin punta (ver relationAttrs).
        '.marker-target': { d: 'M 0 0' }
      },
      labels: [
        {
          position: { distance: 20, offset: -10 },
          attrs: { text: { text: '0..1', fill: '#333', fontSize: 12 } },
          markup: [{ tagName: 'text', selector: 'text' }]
        },
        {
          position: { distance: -20, offset: -10 },
          attrs: { text: { text: '1..*', fill: '#333', fontSize: 12 } },
          markup: [{ tagName: 'text', selector: 'text' }]
        }
      ]
    });
  }


  private readonly relationAttrs: any = {
    association: {
      '.connection': { stroke: '#333', 'stroke-width': 2 },
      // Sin punta: en UML la asociación binaria simple es solo la línea. La
      // punta abierta indica navegabilidad, y como acá todas las asociaciones
      // llevarían la misma no marcaría nada. El triángulo relleno que había
      // antes pertenece al adorno de dirección del nombre, que va en el medio.
      //
      // El trazo vacío se declara, no se omite: `attr()` fusiona los atributos
      // (ver applyRelationshipChanges), así que sin esto la punta de la
      // herencia o la dependencia sobreviviría al cambio de tipo.
      '.marker-target': { d: 'M 0 0' }
    },
    generalization: {
      '.connection': { stroke: '#333', 'stroke-width': 2 },
      '.marker-target': {
        d: 'M 20 0 L 0 10 L 20 20 z',
        fill: '#fff',
        stroke: '#333',
        // Marca la punta como hueca para que el tema la rellene con el
        // color del lienzo en lugar del color de la línea.
        'data-hollow': 'true'
      }
    },
    aggregation: {
      '.connection': { stroke: '#333', 'stroke-width': 2 },
      '.marker-source': {
        d: 'M 0 10 L 10 0 L 20 10 L 10 20 z',
        fill: '#fff',
        stroke: '#333',
        'data-hollow': 'true'
      }
    },
    composition: {
      '.connection': { stroke: '#333', 'stroke-width': 2 },
      '.marker-source': {
        d: 'M 0 10 L 10 0 L 20 10 L 10 20 z',
        fill: '#333'
      }
    },
    dependency: {
      '.connection': { stroke: '#333', 'stroke-width': 2, 'stroke-dasharray': '4 2' },
      '.marker-target': {
        // Punta abierta: el trazo no cierra (sin `z`) ni se rellena, que es
        // como UML dibuja la dependencia. Antes usaba el mismo triángulo
        // relleno que la asociación.
        d: 'M 10 0 L 0 5 L 10 10',
        fill: 'none',
        stroke: '#333',
        'stroke-width': 2,
        'data-open': 'true'
      }
    },
    // Clase de asociación: une el punto medio de una asociación con la clase que
    // lleva los atributos de esa relación (la "tabla intermedia"). A diferencia
    // de las otras cinco, su origen es un conector y no una clase.
    // Se dibuja punteada y sin adornos en ninguno de los dos extremos.
    associationClass: {
      '.connection': { stroke: '#333', 'stroke-width': 2, 'stroke-dasharray': '5 4' },
      '.marker-source': { d: 'M 0 0' },
      '.marker-target': { d: 'M 0 0' }
    }
  };

  /** Tipos de relación cuyo origen es un conector en lugar de una clase. */
  static readonly LINK_ANCHORED_TYPES = ['associationClass'];

  static isLinkAnchored(type: string): boolean {
    return DiagramService.LINK_ANCHORED_TYPES.includes(type);
  }

  /**
   * Crea una relación tipada entre dos elementos y la añade al grafo
  */
  createTypedRelationship(
    sourceId: string,
    targetId: string,
    type: string = 'association',
    remote: boolean = false
  ) {
    const attrs = this.relationAttrs[type] || this.relationAttrs.association;

    const link = new this.joint.dia.Link({
      name: 'Relacion',
      relationType: type,             // 👈 guarda el tipo
      source: { id: sourceId },
      target: { id: targetId },
      attrs
    });

    // Una clase de asociación no tiene multiplicidades: describe los atributos de
    // una relación, no la relación misma. Las cardinalidades ya están en el
    // conector del que cuelga.
    if (!DiagramService.isLinkAnchored(type)) {
      link.set('labels', [
        {
          position: { distance: 20, offset: -10 },
          attrs: { text: { text: '0..1', fill: '#333', fontSize: 12 } },
          markup: [{ tagName: 'text', selector: 'text' }]
        },
        {
          position: { distance: -20, offset: -10 },
          attrs: { text: { text: '1..*', fill: '#333', fontSize: 12 } },
          markup: [{ tagName: 'text', selector: 'text' }]
        }
      ]);
    }

    if (!remote) {
      this.graph.addCell(link);       // 👈 disparará 'add' → broadcast
    }
    return link;
  }

  /**************************************************************************************************
   * FUNCIONES AUXILIARES
   ***************************************************************************************************/
  deleteSelected() {
    if (!this.selectedCell) return;
    const id = this.selectedCell.id;
    this.selectedCell.remove();
    this.collab.broadcast({ t: 'delete', id });
    this.selectedCell = null;
  }

  // Copiar clase UML seleccionada
  private copyUmlClass(cell: any): UmlClass | null {
    if (!cell?.isElement?.()) return null;
    return {
      id: undefined, // Nueva copia
      name: cell.get('name'),
      position: { x: cell.position().x + 30, y: cell.position().y + 30 }, // desplazada
      size: cell.size(),
      attributes: cell.get('attributes'),
      methods: cell.get('methods'),
    };
  }

  // Pegar clase UML desde el portapapeles
  private pasteUmlClass(classModel: UmlClass | null) {
    if (!classModel) return;
    const newClass = this.createUmlClass(classModel);
    newClass.toFront();
    this.selectedCell = newClass;
  }

  clearSelection() {
    if (this.selectedCell?.isElement?.()) {
      this.selectedCell.attr('.uml-outer/stroke', '#2196f3');
      this.selectedCell.attr('.uml-outer/stroke-width', 2);
      this.selectedCell.getPorts().forEach((p: any) => {
        this.selectedCell.portProp(p.id, 'attrs/circle/display', 'none');
      });
    }
    this.selectedCell = null;
  }

  // ========= Obtener índice de etiqueta clicada =========
  private getClickedLabelIndex(linkView: any, evt: MouseEvent): number | null {
    const labels = linkView.model.labels();
    if (!labels || labels.length === 0) return null;
    for (let i = 0; i < labels.length; i++) {
      const node = linkView.findLabelNode(i);
      if (node && (evt.target === node || node.contains(evt.target as Node))) return i;
    }
    return null;
  }

  saveDiagram() {
    const json = this.exportService.export(this.graph);
    console.log('JSON limpio:', JSON.stringify(json, null, 2));

    // Aquí ya lo puedes mandar con HttpClient al backend
    // this.http.post('/api/diagrams', json).subscribe(...)
  }

  /**************************************************************************************************
   * CONFIFURACIÓN Y CREACIÓN DE UML
   ***************************************************************************************************/
  // ========= Crea una clase UML con la estructura de tres compartimentos =========
  createUmlClass(classModel: UmlClass, remote: boolean = false): any {
    try {
      if (!this.joint || !this.graph) {
        throw new Error('JointJS no está inicializado');
      }
      // 👇 Forzar la creación del namespace custom
      this.createUmlNamespace();
      // 🔹 Normalizar atributos/métodos a texto multilinea
      const attributesText = Array.isArray(classModel.attributes)
        ? classModel.attributes.map(a => `${a.name}: ${a.type}`).join('\n')
        : (classModel.attributes || '');
      const methodsText = Array.isArray(classModel.methods)
        ? classModel.methods.map(m => {
          const params = m.parameters ? `(${m.parameters})` : '()';
          const ret = m.returnType ? `: ${m.returnType}` : '';
          return `${m.name}${params}${ret};`;
        }).join('\n')
        : (classModel.methods || '');
      // 👇 Usar la clase custom
      const umlClass = new this.joint.shapes.custom.UMLClass({
        position: classModel.position,
        size: classModel.size || { width: 180, height: 110 },
        name: classModel.name || 'Entidad',
        attributes: attributesText,
        methods: methodsText,
      });
      // 🔹 Asignar ID remoto si viene del payload
      if (classModel.id) {
        umlClass.set('id', classModel.id);
      } else {
        umlClass.set('id', uuid());
      }
      // 🔹 Añadimos 4 puertos (uno por cada lado)
      umlClass.addPort({ group: 'inout', id: 'top' });
      umlClass.addPort({ group: 'inout', id: 'bottom' });
      umlClass.addPort({ group: 'inout', id: 'left' });
      umlClass.addPort({ group: 'inout', id: 'right' });
      umlClass.on('change:size', () => this.edition.updatePorts(umlClass));
      umlClass.on('change:attrs', () => this.edition.scheduleAutoResize(this.paper, umlClass));
      // 🔹 Añadir al grafo SOLO UNA VEZ
      this.graph.addCell(umlClass);
      this.edition.scheduleAutoResize(umlClass, this.paper);
      umlClass.toFront();
      // 🔹 Difundir creación SOLO si fue local
      if (!remote) {
        this.collab.broadcast({
          t: 'add_class',
          id: umlClass.id,
          payload: {
            name: classModel.name,
            position: classModel.position,
            size: classModel.size,
            attributes: classModel.attributes,
            methods: classModel.methods,
          },
        });
      }
      return umlClass;
    } catch (error) {
      console.error('Error al crear clase UML personalizada:', error);
      throw error;
    }
  }

  // ========= Configura los eventos interactivos para un elemento =========
  setupClassInteraction(element: any): void {
    try {
      const elementView = this.paper.findViewByModel(element);
      if (elementView) {
        // elementView.on('element:pointerdblclick', () => {
        //   console.log('Doble clic en elemento - editar propiedades');
        //   // Aquí podríamos abrir un diálogo para editar propiedades
        // });
      }
    } catch (error) {
      console.error('Error al configurar interacción:', error);
    }
  }

  // ========= Crea un namespace UML personalizado si no existe en JointJS =========
  private createUmlNamespace(): void {
    if (!this.joint) return;
    if (this.joint.shapes.custom?.UMLClass) return;
    this.joint.shapes.custom = this.joint.shapes.custom || {};
    this.joint.shapes.custom.UMLClass = this.joint.dia.Element.define('custom.UMLClass', {
      size: { width: 180, height: 110 },
      name: 'Entidad',
      attributes: '',
      methods: '',
      attrs: {
        '.uml-outer': {
          strokeWidth: 2,
          stroke: '#2196f3',
          fill: '#ffffff',
          width: 180, // Fijo para evitar cambios inesperados
          height: 110, // Fijo para evitar cambios inesperados
        },
        // Desplazado 1px hacia adentro y 2px más angosto: el trazo de
        // `.uml-outer` se monta sobre el borde (1px adentro, 1px afuera) y este
        // rectángulo se dibuja encima. Sin el margen le tapaba la mitad interior
        // y el borde del encabezado se veía la mitad de grueso que el del cuerpo.
        '.uml-class-name-rect': { x: 1, y: 1, refWidth: -2, height: 29, fill: '#e3f2fd' },
        // El divisor del nombre cierra el encabezado, así que lleva el grosor
        // del borde; el de atributos separa dos secciones del cuerpo y queda fino.
        '.sep-name': { stroke: '#2196f3', strokeWidth: 2, shapeRendering: 'crispEdges' },
        '.sep-attrs': { stroke: '#2196f3', strokeWidth: 1, shapeRendering: 'crispEdges' },
        '.uml-class-name-text': {
          ref: '.uml-class-name-rect',
          refY: .5,
          refX: .5,
          textAnchor: 'middle',
          yAlignment: 'middle',
          fontWeight: 'bold',
          fontSize: 14,
          fill: '#000',
          text: 'Entidad',
        },
        '.uml-class-attrs-text': {
          fontSize: 12,
          fill: '#000',
          text: '',
          textWrap: { width: -20, height: 'auto' },
          whiteSpace: 'pre-wrap',
        },
        '.uml-class-methods-text': {
          fontSize: 12,
          fill: '#000',
          text: '',
          textWrap: { width: -20, height: 'auto' },
          whiteSpace: 'pre-wrap',
        },
      },
      ports: {
        groups: {
          inout: {
            position: { name: 'absolute' },
            attrs: {
              circle: {
                r: 5,
                magnet: true,
                stroke: '#2196f3',
                fill: '#fff',
                'stroke-width': 2,
                display: 'none',
              },
            },
          },
        },
      },
    }, {
      markup: [
        '<g class="rotatable">',
        '<g class="scalable">',
        '<rect class="uml-outer"/>',
        '</g>',
        '<rect class="uml-class-name-rect"/>',
        '<line class="sep-name"/>',
        '<line class="sep-attrs"/>',
        '<text class="uml-class-name-text"/>',
        '<text class="uml-class-attrs-text"/>',
        '<text class="uml-class-methods-text"/>',
        '<g class="ports"/>',
        '</g>',
      ].join(''),
    });
    // Sync textos → attrs
    this.joint.shapes.custom.UMLClass.prototype.updateRectangles = function () {
      this.attr({
        '.uml-class-name-text': { text: this.get('name') || '' },
        '.uml-class-attrs-text': { text: this.get('attributes') || '' },
        '.uml-class-methods-text': { text: this.get('methods') || '' },
      });
    };
    this.joint.shapes.custom.UMLClass.prototype.initialize = function () {
      this.on('change:name change:attributes change:methods', this.updateRectangles, this);
      this.updateRectangles();
      this.constructor.__super__.initialize.apply(this, arguments);
    };
  }

  private buildLinkForRemote = (sourceId?: string, targetId?: string) =>
    new this.joint.dia.Link({
      name: 'Relacion',
      source: sourceId ? { id: sourceId } : undefined,
      target: targetId ? { id: targetId } : undefined,
      attrs: {
        '.connection': { stroke: '#333333', 'stroke-width': 2 },
        // Misma forma que la local: el conector que llega de otro participante
        // no puede verse distinto del que dibujamos acá.
        '.marker-target': { d: 'M 0 0' },
      },
      labels: [
        {
          position: { distance: 20, offset: -10 },
          attrs: { text: { text: '0..1', fill: '#333' } },
        },
        {
          position: { distance: -20, offset: -10 },
          attrs: { text: { text: '1..*', fill: '#333' } },
        },
      ],
    });

  // Expose para otros servicios (collab)
  getGraph() {
    return this.graph;
  }
  getJoint() {
    return this.joint;
  }
  loadFromJson(json: any, isStorageLoad: boolean = false) {
    if (!this.graph) return;

    // DETECTAR SI ES UNA ELIMINACIÓN (tiene elementos con "eliminar": true)
    const hasDeleteMarkers = this.checkForDeleteMarkers(json);
    if (hasDeleteMarkers) {
      this.handleDeleteOperation(json);
      return;
    }

    // DETECTAR SI ES UNA EDICIÓN (tiene estructura original/editado)
    if (json.original && json.editado) {
      this.handleEditOperation(json);
      return;
    }

    const idMap: Record<string, string> = {};
    // mapea el id original del JSON -> id real en el canvas

    // 1. Crear (o reusar) todas las clases
    json.classes.forEach((cls: any) => {
      const existing = this.graph.getCells().find((c: any) => {
        return c.isElement?.() && c.get('name') === cls.name;
      });
      if (existing && isStorageLoad) {
        idMap[cls.id] = existing.id;
        // 🔹 restaurar posición/tamaño si vino del storage
        if (cls.position) existing.position(cls.position.x, cls.position.y);
        if (cls.size) existing.resize(cls.size.width, cls.size.height);
      } else {
        const newCls = this.createUmlClass({
          id: cls.id,
          name: cls.name,
          position: cls.position || { x: 100, y: 100 },
          size: cls.size || { width: 180, height: 110 },
          attributes: cls.attributes,
          methods: cls.methods
        });

        idMap[cls.id] = newCls.id;
      }
    });

    // 2. Crear todas las relaciones.
    //
    // En dos pasadas: una clase de asociación se ancla a un conector, así que ese
    // conector tiene que existir antes. El orden de `json.relationships` no lo
    // garantiza, porque al exportar sale del recorrido de celdas del grafo.
    const plainRels = json.relationships.filter(
      (rel: any) => !DiagramService.isLinkAnchored(rel.type)
    );
    const linkAnchoredRels = json.relationships.filter(
      (rel: any) => DiagramService.isLinkAnchored(rel.type)
    );

    const restoreRelationship = (rel: any) => {
      // Los ids de las clases se remapean; los de los conectores se conservan tal
      // cual (`link.set('id', ...)` más abajo), así que una referencia a un
      // conector cae en el `|| rel.sourceId` y resuelve igual.
      const srcId = idMap[rel.sourceId] || rel.sourceId;
      const trgId = idMap[rel.targetId] || rel.targetId;

      const existingLink = this.graph.getLinks().find((l: any) => {
        return (
          l.get('source')?.id === srcId &&
          l.get('target')?.id === trgId &&
          l.get('relationType') === rel.type
        );
      });

      if (existingLink) return;

      // Si el extremo de origen es un conector que no llegó a crearse, no tiene
      // sentido colgar nada de él: JointJS lanzaría al resolver la vista.
      if (DiagramService.isLinkAnchored(rel.type) && !this.graph.getCell(srcId)) {
        console.warn('[Diagram] Clase de asociación sin conector de origen, se omite:', rel.id);
        return;
      }

      const link = this.createTypedRelationship(srcId, trgId, rel.type, true);
      link.set('id', rel.id);

      // 🔹 aplicar labels si vienen
      if (rel.labels && !DiagramService.isLinkAnchored(rel.type)) {
        link.set(
          'labels',
          rel.labels.map((txt: string, i: number) => ({
            position: { distance: i === 0 ? 20 : -20, offset: -10 },
            attrs: { text: { text: txt, fill: '#333', fontSize: 12 } },
            markup: [{ tagName: 'text', selector: 'text' }]
          }))
        );
      }

      // 🔹 restaurar vértices si existen
      if (rel.vertices && rel.vertices.length > 0) {
        link.set('vertices', rel.vertices);
      }

      this.graph.addCell(link);
    };

    plainRels.forEach(restoreRelationship);
    linkAnchoredRels.forEach(restoreRelationship);
  }

  /**
   * Verifica si el JSON tiene marcadores de eliminación
   */
  private checkForDeleteMarkers(json: any): boolean {
    // Verificar si alguna clase tiene eliminar: true
    if (json.classes && json.classes.some((cls: any) => cls.eliminar === true)) {
      return true;
    }

    // Verificar si alguna clase tiene atributos con eliminar: true
    if (json.classes && json.classes.some((cls: any) =>
      cls.attributes && cls.attributes.some((attr: any) => attr.eliminar === true)
    )) {
      return true;
    }

    // Verificar si alguna clase tiene métodos con eliminar: true
    if (json.classes && json.classes.some((cls: any) =>
      cls.methods && cls.methods.some((method: any) => method.eliminar === true)
    )) {
      return true;
    }

    // Verificar si alguna relación tiene eliminar: true
    if (json.relationships && json.relationships.some((rel: any) => rel.eliminar === true)) {
      return true;
    }

    return false;
  }

  /**
   * Maneja operaciones de eliminación cuando llegan elementos marcados con "eliminar": true
   */
  private handleDeleteOperation(deleteData: any) {
    console.log('🗑️ Procesando eliminación de elementos UML', deleteData);

    // 1. Eliminar clases completas
    if (deleteData.classes) {
      deleteData.classes.forEach((cls: any) => {
        if (cls.eliminar === true) {
          // Eliminar clase completa
          const existingElement = this.graph.getCells().find((cell: any) => {
            if (!cell.isElement?.()) return false;
            return cell.get('name') === cls.name || cell.id === cls.id;
          });

          if (existingElement) {
            console.log(`🗑️ Eliminando clase completa: "${cls.name}"`);
            existingElement.remove();

            // Broadcast para colaboración
            this.collab.broadcast({
              t: 'delete',
              id: existingElement.id
            });
          } else {
            console.warn(`⚠️ No se encontró la clase "${cls.name}" para eliminar`);
          }
        } else {
          // La clase no se elimina completa, pero puede tener atributos/métodos a eliminar
          const existingElement = this.graph.getCells().find((cell: any) => {
            if (!cell.isElement?.()) return false;
            return cell.get('name') === cls.name || cell.id === cls.id;
          });

          if (!existingElement) {
            console.warn(`⚠️ No se encontró la clase "${cls.name}"`);
            return;
          }

          // 2. Eliminar atributos específicos
          if (cls.attributes && cls.attributes.length > 0) {
            const currentAttributes = existingElement.get('attributes') || '';
            const attrLines = currentAttributes.split('\n').filter((line: string) => line.trim());

            const attributesToDelete = cls.attributes
              .filter((attr: any) => attr.eliminar === true)
              .map((attr: any) => attr.name);

            const newAttributes = attrLines.filter((line: string) => {
              const attrName = line.split(':')[0]?.trim();
              const shouldDelete = attributesToDelete.includes(attrName);
              if (shouldDelete) {
                console.log(`🗑️ Eliminando atributo "${attrName}" de "${cls.name}"`);
              }
              return !shouldDelete;
            }).join('\n');

            existingElement.set('attributes', newAttributes);

            // Broadcast para colaboración
            this.collab.broadcast({
              t: 'edit_text',
              id: existingElement.id,
              field: 'attributes',
              value: newAttributes
            });
          }

          // 3. Eliminar métodos específicos
          if (cls.methods && cls.methods.length > 0) {
            const currentMethods = existingElement.get('methods') || '';
            const methodLines = currentMethods.split('\n').filter((line: string) => line.trim());

            const methodsToDelete = cls.methods
              .filter((method: any) => method.eliminar === true)
              .map((method: any) => method.name);

            const newMethods = methodLines.filter((line: string) => {
              const methodName = line.split('(')[0]?.trim();
              const shouldDelete = methodsToDelete.includes(methodName);
              if (shouldDelete) {
                console.log(`🗑️ Eliminando método "${methodName}" de "${cls.name}"`);
              }
              return !shouldDelete;
            }).join('\n');

            existingElement.set('methods', newMethods);

            // Broadcast para colaboración
            this.collab.broadcast({
              t: 'edit_text',
              id: existingElement.id,
              field: 'methods',
              value: newMethods
            });
          }

          // Redimensionar después de eliminar contenido
          this.edition.scheduleAutoResize(this.paper, existingElement);
        }
      });
    }

    // 4. Eliminar relaciones
    if (deleteData.relationships) {
      deleteData.relationships.forEach((rel: any) => {
        if (rel.eliminar === true) {
          // Buscar las clases por nombre
          const sourceElement = this.graph.getCells().find((cell: any) =>
            cell.isElement?.() && cell.get('name') === rel.sourceId
          );
          const targetElement = this.graph.getCells().find((cell: any) =>
            cell.isElement?.() && cell.get('name') === rel.targetId
          );

          if (!sourceElement || !targetElement) {
            console.warn(`⚠️ No se encontraron las clases "${rel.sourceId}" o "${rel.targetId}"`);
            return;
          }

          // Buscar la relación entre estas clases
          const existingLink = this.graph.getLinks().find((link: any) => {
            const linkSourceId = link.get('source')?.id;
            const linkTargetId = link.get('target')?.id;

            // Buscar por conexión
            if (linkSourceId === sourceElement.id && linkTargetId === targetElement.id) {
              // Si se especifica tipo, verificar que coincida
              if (rel.type) {
                return link.get('relationType') === rel.type;
              }
              return true;
            }
            return false;
          });

          if (existingLink) {
            console.log(`🗑️ Eliminando relación entre "${rel.sourceId}" -> "${rel.targetId}"`);
            existingLink.remove();

            // Broadcast para colaboración
            this.collab.broadcast({
              t: 'delete',
              id: existingLink.id
            });
          } else {
            console.warn(`⚠️ No se encontró relación entre "${rel.sourceId}" -> "${rel.targetId}"`);
          }
        }
      });
    }

    console.log('✅ Eliminación completada exitosamente');
  }

  /**
   * Maneja operaciones de edición cuando llegan dos JSONs (original y editado)
   */
  private handleEditOperation(editData: { original: any; editado: any }) {
    //console.log('🔄 Procesando edición de clase UML', editData);

    // 1. Buscar la clase a editar usando el JSON original
    const originalClass = editData.original.classes?.[0];
    if (!originalClass) {
      //console.error('❌ No se encontró clase en JSON original');
      return;
    }

    // 2. Buscar la clase en el canvas por nombre o ID
    const existingElement = this.graph.getCells().find((cell: any) => {
      if (!cell.isElement?.()) return false;

      // Buscar por ID si coincide
      if (cell.id === originalClass.id) return true;

      // Buscar por nombre si no hay ID match
      return cell.get('name') === originalClass.name;
    });

    if (!existingElement) {
      console.warn('⚠️ No se encontró la clase en el canvas, creando nueva...');
      // Si no existe, crear la clase original primero
      this.createUmlClass({
        id: originalClass.id,
        name: originalClass.name,
        position: originalClass.position || { x: 100, y: 100 },
        size: originalClass.size || { width: 180, height: 110 },
        attributes: originalClass.attributes,
        methods: originalClass.methods
      });
      return;
    }

    // 3. Aplicar las modificaciones del JSON editado
    const editedClass = editData.editado.classes?.[0];
    if (!editedClass) {
      console.warn('❌ No se encontró clase en JSON editado');
      if (!(editData.editado.relationships) || editData.editado.relationships.length === 0) return;
      //Actualizar relaciones editadas
      if (editData.editado.relationships && editData.editado.relationships.length > 0) {
        editData.editado.relationships.forEach((editedRel: any) => {
          if (editedRel.editado) {
            this.updateRelationship(editedRel, editData.original.relationships, editData.original.classes);
          }
        });
      }
      return;
    }

    //console.log('🎯 Aplicando ediciones a:', existingElement.get('name'));

    // 4. Actualizar propiedades modificadas (nombre)
    if (editedClass.name) {
      const currentCanvasName = existingElement.get('name');

      // Si el JSON original tiene el nombre de la clase, significa que se debe editar
      if (originalClass.name === currentCanvasName) {
        // Aplicar el nombre editado desde el JSON editado
        existingElement.set('name', editedClass.name);
        console.log(`✏️ Nombre actualizado: "${currentCanvasName}" -> "${editedClass.name}"`);
      } else {
        console.log(`✅ Manteniendo nombre actual del canvas: "${currentCanvasName}"`);
      }
    }

    // 5. Actualizar atributos
    if (editedClass.attributes) {
      // Obtener atributos ACTUALES del canvas (no del JSON original)
      const currentCanvasAttributes = existingElement.get('attributes') || '';

      // Convertir atributos editados a formato texto
      const newAttributesText = Array.isArray(editedClass.attributes)
        ? editedClass.attributes
          .map((attr: any) => `${attr.name}: ${attr.type}`)
          .join('\n')
        : editedClass.attributes;

      // Mezclar atributos comparando original vs canvas, reemplazando con editado
      const finalAttributes = this.mergeAttributes(
        currentCanvasAttributes,
        newAttributesText,
        editedClass.attributes,
        originalClass.attributes || []
      );

      existingElement.set('attributes', finalAttributes);
      //console.log('📝 Atributos actualizados usando comparación original vs canvas:', finalAttributes);
    }

    // 6. Actualizar métodos
    if (editedClass.methods) {
      // Obtener métodos ACTUALES del canvas (no del JSON original)
      const currentCanvasMethods = existingElement.get('methods') || '';

      // Convertir métodos editados a formato texto
      const newMethodsText = Array.isArray(editedClass.methods)
        ? editedClass.methods
          .map((m: any) => {
            const params = m.parameters ? `(${m.parameters})` : '()';
            const ret = m.returnType ? `: ${m.returnType}` : '';
            return `${m.name}${params}${ret};`;
          })
          .join('\n')
        : editedClass.methods;

      // Mezclar métodos comparando original vs canvas, reemplazando con editado
      const finalMethods = this.mergeMethods(
        currentCanvasMethods,
        newMethodsText,
        editedClass.methods,
        originalClass.methods || []
      );

      existingElement.set('methods', finalMethods);
      //console.log('🔧 Métodos actualizados usando comparación original vs canvas:', finalMethods);
    }

    // 7. Broadcast de la edición para colaboración (enviar múltiples broadcasts)
    if (editedClass.name && originalClass.name) {
      // Solo hacer broadcast si se detectó que el nombre debía cambiar
      const currentCanvasName = existingElement.get('name');
      if (currentCanvasName === editedClass.name && editedClass.name !== originalClass.name) {
        this.collab.broadcast({
          t: 'edit_text',
          id: existingElement.id,
          field: 'name',
          value: existingElement.get('name')
        });
      }
    }

    if (editedClass.attributes) {
      this.collab.broadcast({
        t: 'edit_text',
        id: existingElement.id,
        field: 'attributes',
        value: existingElement.get('attributes')
      });
    }

    if (editedClass.methods) {
      this.collab.broadcast({
        t: 'edit_text',
        id: existingElement.id,
        field: 'methods',
        value: existingElement.get('methods')
      });
    }

    // 8. Actualizar relaciones editadas
    if (editData.editado.relationships && editData.editado.relationships.length > 0) {
      editData.editado.relationships.forEach((editedRel: any) => {
        if (editedRel.editado) {
          this.updateRelationship(editedRel, editData.original.relationships, editData.original.classes);
        }
      });
    }
    // 9. Redimensionar automáticamente
    this.edition.scheduleAutoResize(existingElement, this.paper);

    //console.log('✅ Edición completada exitosamente');
  }



  /**
   * Mezcla atributos comparando JSON original vs canvas actual, reemplazando con JSON editado
   * 1. Compara JSON original con canvas para ver qué se debe editar
   * 2. Reemplaza esos elementos con los valores del JSON editado
   * 3. Añade elementos que están en original pero no en canvas
   */
  private mergeAttributes(canvasAttributesText: string, editedText: string, editedArray: any[], originalArray: any[] = []): string {
    if (!Array.isArray(editedArray)) return editedText;

    // Parsear atributos actuales del canvas (formato: "nombre: tipo")
    const canvasLines = canvasAttributesText.split('\n').filter(line => line.trim());
    const canvasAttributes = new Map<string, { fullLine: string, type: string }>();

    canvasLines.forEach(line => {
      const colonIndex = line.indexOf(': ');
      if (colonIndex > 0) {
        const name = line.substring(0, colonIndex).trim();
        const type = line.substring(colonIndex + 1).trim();
        canvasAttributes.set(name, { fullLine: line, type });
      }
    });

    // Mapear atributos originales y editados por nombre
    const originalAttributeNames = new Set<string>();

    // Procesar array original (puede ser objetos o strings)
    originalArray.forEach(attr => {
      if (typeof attr === 'object' && attr.name) {
        originalAttributeNames.add(attr.name);
      } else if (typeof attr === 'string') {
        const colonIndex = attr.indexOf(':');
        if (colonIndex > 0) {
          const name = attr.substring(0, colonIndex).trim();
          originalAttributeNames.add(name);
        }
      }
    });

    // Procesar array editado
    // editedArray.forEach(attr => {
    // 	if (typeof attr === 'object' && attr.name) {
    // 		editedAttributes.set(attr.name, attr);
    // 	}
    // });
    // console.log('----------------------------------------');
    // console.log('🔍 Canvas actual:', Array.from(canvasAttributes.keys()));
    // console.log('🔍 JSON original:', Array.from(originalAttributeNames));
    // console.log('🔍 JSON editado:', Array.from(editedArray));

    const finalLines: string[] = [];

    // 1. Procesar atributos que están en el canvas
    canvasAttributes.forEach((canvasData, canvasName) => {
      // Verificar si este atributo del canvas debe ser editado
      if (originalAttributeNames.has(canvasName)) {
        // Este atributo existe en original y editado, reemplazar con editado;
        const editedAttr = editedArray.shift();
        const newLine = `${editedAttr.name}: ${editedAttr.type}`;
        finalLines.push(newLine);
        //console.log(`✏️ Editando "${canvasName}" del canvas: "${canvasData.fullLine}" -> "${newLine}"`);
      } else {
        // Mantener el atributo del canvas sin cambios
        finalLines.push(canvasData.fullLine);
        //console.log(`✅ Manteniendo "${canvasName}" del canvas: "${canvasData.fullLine}"`);
      }
    });

    // 2. Añadir atributos que están en editado pero NO en canvas
    editedArray.forEach(editedName => {
      if (!canvasAttributes.has(editedName)) {
        // Este atributo no existe en canvas pero sí en original y editado
        const editedAttr = editedArray.shift();
        const newLine = `${editedAttr.name}: ${editedAttr.type}`;
        finalLines.push(newLine);
        //console.log(`🆕 Añadiendo "${editedName}" que no estaba en canvas: "${newLine}"`);
      }
    });

    const result = finalLines.join('\n');
    //console.log('📝 Resultado final de atributos:', result);
    return result;
  }

  /**
   * Mezcla métodos comparando JSON original vs canvas actual, reemplazando con JSON editado
   * 1. Compara JSON original con canvas para ver qué se debe editar
   * 2. Reemplaza esos elementos con los valores del JSON editado
   * 3. Añade elementos que están en original pero no en canvas
   */
  private mergeMethods(canvasMethodsText: string, editedText: string, editedArray: any[], originalArray: any[] = []): string {
    if (!Array.isArray(editedArray)) return editedText;

    // Parsear métodos actuales del canvas (formato: "nombre(params): tipo;")
    const canvasLines = canvasMethodsText.split('\n').filter(line => line.trim());
    const canvasMethods = new Map<string, string>();

    canvasLines.forEach(line => {
      const parenIndex = line.indexOf('(');
      if (parenIndex > 0) {
        const methodName = line.substring(0, parenIndex).trim();
        canvasMethods.set(methodName, line);
      }
    });

    // Mapear métodos originales y editados por nombre
    const originalMethodNames = new Set<string>();

    // Procesar array original (puede ser objetos o strings)
    originalArray.forEach(method => {
      if (typeof method === 'object' && method.name) {
        originalMethodNames.add(method.name);
      } else if (typeof method === 'string') {
        const parenIndex = method.indexOf('(');
        if (parenIndex > 0) {
          const name = method.substring(0, parenIndex).trim();
          originalMethodNames.add(name);
        }
      }
    });

    // Procesar array editado
    // editedArray.forEach(method => {
    // 	if (typeof method === 'object' && method.name) {
    // 		editedMethods.set(method.name, method);
    // 	}
    // });

    // console.log('🔍 Canvas actual:', Array.from(canvasMethods.keys()));
    // console.log('🔍 JSON original:', Array.from(originalMethodNames));
    // console.log('🔍 JSON editado:', Array.from(editedMethods.keys()));

    const finalLines: string[] = [];

    // 1. Procesar métodos que están en el canvas
    canvasMethods.forEach((canvasLine, canvasName) => {
      // Verificar si este método del canvas debe ser editado
      if (originalMethodNames.has(canvasName)) {
        // Este método existe en original y editado, reemplazar con editado
        const editedMethod = editedArray.shift();
        const params = editedMethod.parameters ? `(${editedMethod.parameters})` : '()';
        const ret = editedMethod.returnType ? `: ${editedMethod.returnType}` : '';
        const newLine = `${editedMethod.name}${params}${ret};`;
        finalLines.push(newLine);
        //console.log(`✏️ Editando "${canvasName}" del canvas: "${canvasLine}" -> "${newLine}"`);
      } else {
        // Mantener el método del canvas sin cambios
        finalLines.push(canvasLine);
        //console.log(`✅ Manteniendo "${canvasName}" del canvas: "${canvasLine}"`);
      }
    });

    // 2. Añadir métodos que están en edited pero NO en canvas
    editedArray.forEach(editedName => {
      if (!canvasMethods.has(editedName)) {
        // Este método no existe en canvas pero sí en original y editado
        const editedMethod = editedArray.shift();
        const params = editedMethod.parameters ? `(${editedMethod.parameters})` : '()';
        const ret = editedMethod.returnType ? `: ${editedMethod.returnType}` : '';
        const newLine = `${editedMethod.name}${params}${ret};`;
        finalLines.push(newLine);
        //console.log(`🆕 Añadiendo "${editedName}" que no estaba en canvas: "${newLine}"`);
      }
    });

    const result = finalLines.join('\n');
    //console.log('🔧 Resultado final de métodos:', result);
    return result;
  }

  /**
   * Actualiza una relación existente en el canvas con los datos editados
   * Busca las clases por nombre y luego la relación por tipo y conexiones
   */
  private updateRelationship(editedRelation: any, originalRelationships: any[] = [], originalClasses: any[] = []) {
    if (!editedRelation) return;

    // 1. Buscar la relación original correspondiente por ID
    const originalRelation = originalRelationships.find(rel => rel.id === editedRelation.id);
    if (!originalRelation) {
      console.warn(`⚠️ No se encontró relación original con ID: ${editedRelation.id}`);
      return;
    }

    //console.log(`📋 Relación original encontrada:`, originalRelation);

    // 2. Buscar las clases origen y destino por sus nombres en el JSON original
    const sourceClass = originalClasses.find(cls => cls.id === originalRelation.sourceId);
    const targetClass = originalClasses.find(cls => cls.id === originalRelation.targetId);

    if (!sourceClass || !targetClass) {
      console.warn(`⚠️ No se encontraron clases origen/destino en JSON original`);
      return;
    }

    //console.log(`📝 Clases identificadas: "${sourceClass.name}" -> "${targetClass.name}"`);

    // 3. Buscar estas clases en el canvas por nombre
    const canvasSourceElement = this.graph.getCells().find((cell: any) =>
      cell.isElement?.() && cell.get('name') === sourceClass.name
    );
    const canvasTargetElement = this.graph.getCells().find((cell: any) =>
      cell.isElement?.() && cell.get('name') === targetClass.name
    );

    if (!canvasSourceElement || !canvasTargetElement) {
      console.warn(`⚠️ No se encontraron las clases "${sourceClass.name}" o "${targetClass.name}" en el canvas`);
      return;
    }

    //console.log(`🎯 Clases encontradas en canvas: "${canvasSourceElement.get('name')}" (${canvasSourceElement.id}) -> "${canvasTargetElement.get('name')}" (${canvasTargetElement.id})`);

    // 4. Buscar la relación existente entre estas clases con el tipo original
    const existingLink = this.graph.getLinks().find((link: any) => {
      const linkSourceId = link.get('source')?.id;
      const linkTargetId = link.get('target')?.id;
      const linkType = link.get('relationType');

      return linkSourceId === canvasSourceElement.id &&
        linkTargetId === canvasTargetElement.id &&
        linkType === originalRelation.type;
    });

    if (!existingLink) {
      console.warn(`⚠️ No se encontró relación ${originalRelation.type} entre "${sourceClass.name}" -> "${targetClass.name}" en el canvas`);
      // Intentar buscar cualquier relación entre estas dos clases
      const anyLink = this.graph.getLinks().find((link: any) => {
        const linkSourceId = link.get('source')?.id;
        const linkTargetId = link.get('target')?.id;

        return linkSourceId === canvasSourceElement.id && linkTargetId === canvasTargetElement.id;
      });

      if (anyLink) {
        //console.log(`� Encontrada relación existente de tipo ${anyLink.get('relationType')}, actualizándola...`);
        // Crear una versión segura del editedRelation que no cambie conexiones
        const safeEditedRelation = {
          ...editedRelation,
          sourceId: canvasSourceElement.id, // Usar IDs reales del canvas
          targetId: canvasTargetElement.id  // Usar IDs reales del canvas
        };
        this.applyRelationshipChanges(anyLink, safeEditedRelation);
        return;
      }

      // Si no existe ninguna relación, crear una nueva
      //console.log(`� Creando nueva relación ${editedRelation.type} entre "${sourceClass.name}" -> "${targetClass.name}"`);
      this.createNewRelationshipFromEdit(canvasSourceElement.id, canvasTargetElement.id, editedRelation);
      return;
    }

    //console.log(`🔗 Actualizando relación existente: ${originalRelation.type} -> ${editedRelation.type}`);
    // Crear una versión segura del editedRelation que use IDs reales del canvas
    const safeEditedRelation = {
      ...editedRelation,
      sourceId: canvasSourceElement.id, // Usar IDs reales del canvas
      targetId: canvasTargetElement.id  // Usar IDs reales del canvas
    };
    this.applyRelationshipChanges(existingLink, safeEditedRelation);
  }

  /**
   * Crea una nueva relación basada en los datos de edición
   */
  private createNewRelationshipFromEdit(sourceId: string, targetId: string, editedRelation: any) {
    const newLink = this.createTypedRelationship(sourceId, targetId, editedRelation.type, true);

    // Aplicar cardinalidades si existen
    if (editedRelation.labels && Array.isArray(editedRelation.labels)) {
      //console.log(`🏷️ Aplicando cardinalidades a nueva relación:`, editedRelation.labels);

      // Filtrar etiquetas válidas
      const validLabels = editedRelation.labels.filter((label: string) =>
        label && typeof label === 'string' && label.trim() !== ''
      );

      if (validLabels.length > 0) {
        const newLabels = validLabels.map((labelText: string, index: number) => ({
          position: {
            distance: index === 0 ? 20 : -20,
            offset: index === 0 ? -10 : 10
          },
          attrs: {
            text: {
              text: labelText.trim(),
              fill: '#333',
              fontSize: 12,
              fontWeight: 'bold'
            }
          },
          markup: [{ tagName: 'text', selector: 'text' }]
        }));

        newLink.set('labels', newLabels);
        //console.log(`✅ Cardinalidades aplicadas a nueva relación:`, validLabels);
      }
    }

    // Broadcast para colaboración
    this.collab.broadcast({
      t: 'move_link',
      id: newLink.id,
      sourceId: sourceId,
      targetId: targetId
    });

    // Broadcast para etiquetas/cardinalidades
    if (editedRelation.labels && Array.isArray(editedRelation.labels)) {
      const validLabels = editedRelation.labels.filter((label: string) =>
        label && typeof label === 'string' && label.trim() !== ''
      );

      validLabels.forEach((labelText: string, index: number) => {
        this.collab.broadcast({
          t: 'edit_label',
          linkId: newLink.id,
          index: index,
          text: labelText.trim()
        });
        //console.log(`📡 Broadcast cardinalidad nueva relación ${index}: "${labelText.trim()}"`);
      });
    }

    //console.log(`✅ Nueva relación ${editedRelation.type} creada exitosamente`);
  }

  /**
   * Aplica los cambios específicos a una relación encontrada
   */
  private applyRelationshipChanges(existingLink: any, editedRelation: any) {
    // 1. Actualizar tipo de relación
    if (editedRelation.type) {
      const newAttrs = this.relationAttrs[editedRelation.type] || this.relationAttrs.association;
      existingLink.attr(newAttrs);
      existingLink.set('relationType', editedRelation.type);
      //console.log(`✏️ Tipo de relación actualizado: ${editedRelation.type}`);
    }

    // 2. NO actualizar conexiones (sourceId/targetId) aquí
    // Las conexiones ya están correctas porque encontramos la relación por estas conexiones
    // Cambiar las conexiones requeriría buscar las clases por nombre primero

    // Si necesitáramos cambiar conexiones, primero verificaríamos que las celdas existan:
    if (editedRelation.sourceId && editedRelation.sourceId !== existingLink.get('source')?.id) {
      const sourceCell = this.graph.getCell(editedRelation.sourceId);
      if (sourceCell && sourceCell.isElement?.()) {
        existingLink.source({ id: editedRelation.sourceId });
        //onsole.log(`✏️ Origen actualizado: ${editedRelation.sourceId}`);
      } else {
        console.warn(`⚠️ No se pudo cambiar origen - celda ${editedRelation.sourceId} no existe`);
      }
    }

    if (editedRelation.targetId && editedRelation.targetId !== existingLink.get('target')?.id) {
      const targetCell = this.graph.getCell(editedRelation.targetId);
      if (targetCell && targetCell.isElement?.()) {
        existingLink.target({ id: editedRelation.targetId });
        //console.log(`✏️ Destino actualizado: ${editedRelation.targetId}`);
      } else {
        console.warn(`⚠️ No se pudo cambiar destino - celda ${editedRelation.targetId} no existe`);
      }
    }

    // 3. Actualizar etiquetas (cardinalidades)
    if (editedRelation.labels && Array.isArray(editedRelation.labels)) {
      //console.log(`🏷️ Aplicando cardinalidades del JSON editado:`, editedRelation.labels);

      // Filtrar etiquetas vacías
      const validLabels = editedRelation.labels.filter((label: string) =>
        label && typeof label === 'string' && label.trim() !== ''
      );

      if (validLabels.length > 0) {
        const newLabels = validLabels.map((labelText: string, index: number) => ({
          position: {
            distance: index === 0 ? 20 : -20,
            offset: index === 0 ? -10 : 10
          },
          attrs: {
            text: {
              text: labelText.trim(),
              fill: '#333',
              fontSize: 12,
              fontWeight: 'bold'
            }
          },
          markup: [{ tagName: 'text', selector: 'text' }]
        }));

        // Limpiar etiquetas anteriores y aplicar las nuevas
        existingLink.set('labels', []);
        existingLink.set('labels', newLabels);

        //console.log(`✅ Cardinalidades aplicadas exitosamente:`, validLabels);
        //console.log(`📍 Posiciones: ${validLabels.length > 0 ? 'origen' : ''} ${validLabels.length > 1 ? 'destino' : ''}`);
      } else {
        // Si no hay etiquetas válidas, limpiar las existentes
        existingLink.set('labels', []);
        //console.log(`🧹 Cardinalidades limpiadas (no había etiquetas válidas)`);
      }
    } else if (editedRelation.labels === null || editedRelation.labels === undefined) {
      // Si labels es null/undefined, mantener las etiquetas existentes
      //console.log(`➡️ Manteniendo cardinalidades existentes (no especificadas en edición)`);
    } else {
      // Si labels existe pero no es array, limpiar
      existingLink.set('labels', []);
      //console.log(`🧹 Cardinalidades limpiadas (formato inválido)`);
    }

    // 4. Broadcast para colaboración - usando mensajes existentes
    if (editedRelation.sourceId || editedRelation.targetId) {
      this.collab.broadcast({
        t: 'move_link',
        id: existingLink.id,
        sourceId: editedRelation.sourceId || existingLink.get('source')?.id,
        targetId: editedRelation.targetId || existingLink.get('target')?.id
      });
    }

    // Broadcast para actualización de etiquetas si cambiaron
    if (editedRelation.labels && Array.isArray(editedRelation.labels)) {
      const validLabels = editedRelation.labels.filter((label: string) =>
        label && typeof label === 'string' && label.trim() !== ''
      );

      validLabels.forEach((labelText: string, index: number) => {
        this.collab.broadcast({
          t: 'edit_label',
          linkId: existingLink.id,
          index: index,
          text: labelText.trim()
        });
        //console.log(`📡 Broadcast cardinalidad ${index}: "${labelText.trim()}"`);
      });
    }

    //console.log('✅ Relación actualizada exitosamente');
  }

  /**
   * Vuelca en el lienzo un diagrama que viene de afuera (hoy, un XMI de
   * Enterprise Architect) y se lo transmite al resto de la sala.
   *
   * Se difunde el estado completo y no las operaciones una por una porque una
   * importación no es una edición: son decenas de altas que llegarían sueltas y
   * en cualquier orden, y una relación aplicada antes que su clase rompe la
   * vista de JointJS.
   *
   * @param replace `true` pisa lo que había; `false` le suma lo importado.
   */
  importDiagram(json: UmlExportDTO, replace: boolean): void {
    if (!this.graph) return;

    if (replace) {
      // Sin `{ collab: true }` cada celda borrada emitiría su propio `delete` a
      // la sala y dispararía la validación por IA una vez por celda.
      this.graph.clear({ collab: true });
      this.selectedCell = null;
    }

    this.loadFromJson(json);
    this.persist();

    const snapshot = this.exportService.export(this.graph);
    this.collab.broadcast({ t: 'full_state', payload: snapshot, replace });
  }

  // Exporta el estado actual del diagrama a JSON
  exportToJson() {
    if (!this.graph) return null;
    return this.exportService.export(this.graph);
  }
  // Guarda el estado actual del diagrama en localStorages
  private persist() {
    if (!this.graph) return;
    const json = this.exportService.export(this.graph);
    localStorage.setItem(this.storageKey, JSON.stringify(json));
  }

  // Exponer persistencia públicamente para que servicios externos (collab)
  // puedan forzar el guardado del estado (localStorage / backup)
  public persistState(): void {
    this.persist();
  }
  // Limpia el diagrama guardado en localStorage
  clearStorage() {
    localStorage.removeItem(this.storageKey);
  }
  closeDiagram(roomId: string) {
    const snapshot = this.exportToJson();
    if (snapshot) {
      this.backup.setBackupUml(roomId, snapshot).subscribe({
        next: () => {
          console.log('✅ Backup enviado al backend');
          this.collab.closeSocketRTC();
          this.graph?.clear();
          this.selectedCell = null;
        },
        error: (err) => console.error('❌ Error enviando backup:', err)
      });
    }

  }
  zoomIn() {
    this.currentScale = Math.min(this.currentScale + this.zoomStep, this.maxScale);
    this.applyZoom();
  }

  zoomOut() {
    this.currentScale = Math.max(this.currentScale - this.zoomStep, this.minScale);
    this.applyZoom();
  }

  resetZoom() {
    this.currentScale = 1;
    this.applyZoom();
  }

  private applyZoom() {
    if (this.paper) {
      this.paper.scale(this.currentScale, this.currentScale);
      this.paper.translate(this.pan.x, this.pan.y);
    }
  }
  /**
   * Función de prueba para editar relaciones - puedes llamarla desde la consola del navegador
   */
  testEditRelationship() {
    const links = this.graph.getLinks();
    if (links.length === 0) {
      console.log('❌ No hay relaciones para editar');
      return;
    }

    const firstLink = links[0];
    const sourceId = firstLink.get('source')?.id;
    const targetId = firstLink.get('target')?.id;

    // Buscar las clases en el canvas para crear ejemplo realista
    const sourceElement = this.graph.getCell(sourceId);
    const targetElement = this.graph.getCell(targetId);

    if (!sourceElement || !targetElement) {
      console.log('❌ No se pudieron encontrar las clases origen/destino');
      return;
    }

    console.log(`🔗 Editando relación: ${sourceElement.get('name')} -> ${targetElement.get('name')}`);

    // Simular datos como los que vendrían del JSON
    const originalRelationships = [{
      id: 'test_rel_id',
      type: firstLink.get('relationType') || 'association',
      sourceId: 'source_class_id',
      targetId: 'target_class_id',
      labels: []
    }];

    const originalClasses = [
      { id: 'source_class_id', name: sourceElement.get('name') },
      { id: 'target_class_id', name: targetElement.get('name') }
    ];

    // Ejemplo de edición: cambiar tipo y etiquetas
    const editedRel = {
      id: 'test_rel_id',
      type: 'composition',
      sourceId: 'source_class_id',
      targetId: 'target_class_id',
      labels: ['1', '0..*'],
      editado: true
    };

    this.updateRelationship(editedRel, originalRelationships, originalClasses);
  }

  exportToImage(fileName: string = 'diagram.png') {
    if (!this.paper) {
      console.error('❌ Paper no inicializado');
      return;
    }

    // Clonar el nodo SVG actual
    const svgElement = this.paper.svg.cloneNode(true) as SVGSVGElement;

    // ❌ Eliminar elementos no deseados (handles, herramientas, puertos)
    svgElement.querySelectorAll(
      '.marker-vertices, .marker-arrowheads, .link-tools, .tool, .connection-wrap'
    ).forEach(el => el.remove());

    // Ajustar tamaño al contenido
    const bbox = this.paper.getContentBBox();
    svgElement.setAttribute("width", `${bbox.width}`);
    svgElement.setAttribute("height", `${bbox.height}`);
    svgElement.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

    // Convertir a string
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);

    // Crear imagen
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgString], { type: "image/svg+xml;charset=utf-8" }));

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = bbox.width;
      canvas.height = bbox.height;

      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");

      URL.revokeObjectURL(url);
    };

    img.src = url;
  }


}
