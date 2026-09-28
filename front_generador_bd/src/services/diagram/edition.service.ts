import { Injectable } from '@angular/core';
import { v4 as uuid } from 'uuid';
import { CollaborationService } from '../colaboration/collaboration.service';
import { DiagramExportService } from '../exports/diagram-export.service';
import { UmlValidationService } from '../colaboration/uml-validation.service';



@Injectable({ providedIn: 'root' })
export class EditionService {
  readonly MIN_W = 180;
  readonly NAME_H = 30;
  readonly MIN_ATTRS_H = 40;
  readonly MIN_METHS_H = 40;
  readonly PAD_V = 10;
  constructor(
    private exportService: DiagramExportService,
		private umlValidationService: UmlValidationService
  ){}
  // ========= Edición de campos =========
  startEditing(
    model: any,
    paper: any,
    field: 'name' | 'attributes' | 'methods',
    x: number,
    y: number,
    collab?: { broadcast: (msg: any) => void }
  ) {
    const MAP: Record<typeof field, string> = {
      name: '.uml-class-name-text',
      attributes: '.uml-class-attrs-text',
      methods: '.uml-class-methods-text'
    };
    const selector = MAP[field];
    const currentValue = model.attr(`${selector}/text`) || '';

    const paperRect = paper.el.getBoundingClientRect();
    const bbox = model.getBBox();
    const absX = paperRect.left + x;
    const absY = paperRect.top + y;

    const editor = field === 'name'
      ? document.createElement('input')
      : document.createElement('textarea');

    editor.value = currentValue;
    // La apariencia vive en styles.css (.uml-inline-editor) para que siga al
    // tema. Acá sólo va lo que depende de la posición del elemento editado.
    editor.className = 'uml-inline-editor';
    Object.assign(editor.style, {
      left: `${absX}px`,
      top: `${absY}px`,
      minWidth: `${Math.max(120, bbox.width - 20)}px`
    } as CSSStyleDeclaration);

    if (field !== 'name') (editor as HTMLTextAreaElement).rows = 4;

    document.body.appendChild(editor);
    editor.focus();

    let closed = false;
    const finish = (save: boolean) => {
      if (closed) return;
      closed = true;

      if (save) {
        const raw = (editor as HTMLInputElement | HTMLTextAreaElement).value;
        const newValue = field === 'name' ? raw.trim() : raw.replace(/\r?\n/g, '\n');
        model.attr(`${selector}/text`, newValue);
        model.set(field, newValue);
        collab?.broadcast({ t: 'edit_text', id: model.id, field, value: newValue });
        this.scheduleAutoResize(model, paper);
      }
      editor.parentNode && editor.parentNode.removeChild(editor);
    };

    editor.addEventListener('blur', () => finish(true));
      editor.addEventListener('keydown', (evt: Event) => {
        const e = evt as KeyboardEvent;
        if (field === 'name') {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        } else {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        }
      });
  }
  
  // ========= Edición de etiquetas de enlaces =========
  startEditingLabel(
    model: any,
    paper: any,
    labelIndex: number,
    currentValue: string,
    x: number,
    y: number,
    collab?: { broadcast: (msg: any) => void },
    graph?: any
  ) {
    const paperRect = paper.el.getBoundingClientRect();
    const absX = paperRect.left + x;
    const absY = paperRect.top + y;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.className = 'uml-inline-editor uml-inline-editor--label';
    Object.assign(input.style, {
      left: `${absX}px`,
      top: `${absY}px`
    } as CSSStyleDeclaration);

    document.body.appendChild(input);
    input.focus();

    const labelNode = (paper.findViewByModel(model) as any).findLabelNode(labelIndex) as SVGElement;
    // Resaltado por clase en vez de atributo, para que el color lo ponga el tema.
    labelNode?.classList.add('uml-label-editing');

    let closed = false;
    const cleanupHighlight = () => {
      labelNode?.classList.remove('uml-label-editing');
    };
    const finish = (save: boolean) => {
      if (closed) return;
      closed = true;

      if (save) {
        const text = input.value.trim();
        model.label(labelIndex, { ...model.label(labelIndex), attrs: { text: { text } } });
        collab?.broadcast({ t: 'edit_label', linkId: model.id, index: labelIndex, text });
        model.set('label', text);
        const umlJson = this.exportService.export(graph);
        this.umlValidationService.validateModel(umlJson);
      }
      input.parentNode && input.parentNode.removeChild(input);
      cleanupHighlight();
    };

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        finish(e.key !== 'Escape'); // Enter/Espacio = guardar, Escape = cancelar
      }
    });
  }
  // ========= Actualiza la posición de los puertos o puntos de enlace =========
  updatePorts(model: any) {
    if (!model?.isElement?.()) return;
    const { width, height } = model.size();
    model.portProp('top',    'args', { x: width / 2, y: 0 });
    model.portProp('bottom', 'args', { x: width / 2, y: height });
    model.portProp('left',   'args', { x: 0,        y: height / 2 });
    model.portProp('right',  'args', { x: width,    y: height / 2 });
  }

  scheduleAutoResize(model: any, paper: any) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.autoResizeUmlClass(model, paper));
    });
  }

  /**************************************************************************************************
  *                  FUNCIONES PRIVADAS
  ***************************************************************************************************/ 

  // ========= Auto-resize + puertos =========
  private getTextBBox(model: any, paper: any, selector: string): number {
    const view = paper.findViewByModel(model);
    const node = view?.findBySelector(selector)?.[0] as SVGGraphicsElement | undefined;
    try { return node ? node.getBBox().height : 0; } catch { return 0; }
  }

  // ========= Auto-ajusta el tamaño del diagrama UML de clase al contenido =========
  autoResizeUmlClass(model: any, paper: any) {
    if (!model?.isElement?.()) return;

    const width  = Math.max(this.MIN_W, (model.get('size')?.width) || this.MIN_W);
    const nameH  = this.NAME_H;

    const attrsHText = this.getTextBBox(model, paper, '.uml-class-attrs-text');
    const methsHText = this.getTextBBox(model, paper, '.uml-class-methods-text');

    const attrsH = Math.max(this.MIN_ATTRS_H, Math.round((attrsHText || 0) + this.PAD_V));
    const methsH = Math.max(this.MIN_METHS_H, Math.round((methsHText || 0) + this.PAD_V));
    const totalH = Math.round(nameH + attrsH + methsH);

    // Un píxel menos que la franja: el rectángulo arranca en y=1 para no tapar
    // la mitad interior del trazo de `.uml-outer` (ver createUmlNamespace).
    model.attr('.uml-class-name-rect/height', nameH - 1);

    const x1 = 1, x2 = width - 1;
    // El divisor del nombre tiene 2px, así que su centro va en un entero;
    // el de atributos tiene 1px y necesita el medio píxel para verse nítido.
    const ySepName = Math.round(nameH);
    const y2 = Math.round(nameH + attrsH) + 0.5;

    model.attr({
      '.sep-name':  { x1, y1: ySepName, x2, y2: ySepName },
      '.sep-attrs': { x1, y1: y2, x2, y2 }
    });

    model.attr('.uml-class-attrs-text/transform',  `translate(10, ${Math.round(nameH + 10)})`);
    model.attr('.uml-class-attrs-text/textWrap/width', width - 20);

    model.attr('.uml-class-methods-text/transform', `translate(10, ${Math.round(nameH + attrsH + 10)})`);
    model.attr('.uml-class-methods-text/textWrap/width', width - 20);

    model.resize(width, totalH);
    this.updatePorts(model);
  }
}
