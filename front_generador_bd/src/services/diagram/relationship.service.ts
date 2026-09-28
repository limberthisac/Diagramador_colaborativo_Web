import { Injectable } from '@angular/core';
import { DiagramService } from './diagram.service';

@Injectable({ providedIn: 'root' })
export class RelationshipService {
	private sourceElement: any = null;
	private paper: any = null;
	private clickHandler: any = null;
	private currentType: string = 'association'; // por defecto
	private hintEl: HTMLElement | null = null;

	/**
	 * Permite que la interfaz reemplace el aviso propio por el suyo. Si nadie se
	 * engancha, el servicio muestra un cartel flotante sobre el lienzo.
	 */
	onFeedback: ((message: string) => void) | null = null;

	constructor(private diagramService: DiagramService) {}

	/**
	 * Cartel flotante sobre el lienzo. Un mensaje que solo va a la consola no
	 * existe para quien usa la aplicación: el clic parece no hacer nada.
	 */
	private showHint(containerElement: HTMLElement, message: string): void {
		if (this.onFeedback) {
			this.onFeedback(message);
			return;
		}
		if (!this.hintEl) {
			this.hintEl = document.createElement('div');
			this.hintEl.className = 'rel-hint';
		}
		// Este servicio es un singleton, pero el contenedor del lienzo se destruye
		// y se vuelve a crear cada vez que se entra al diagrama. Sin esta
		// comprobación, a partir de la segunda visita el cartel seguiría colgado
		// del contenedor viejo, fuera de la página: invisible aunque funcione.
		// `appendChild` lo mueve si ya estaba en otro lado.
		if (this.hintEl.parentElement !== containerElement) {
			containerElement.appendChild(this.hintEl);
		}
		this.hintEl.textContent = message;
		// Fuerza el cálculo de estilos antes de encender la opacidad, para que la
		// transición corra también en el primer cartel recién insertado.
		void this.hintEl.offsetWidth;
		this.hintEl.classList.add('is-visible');
	}

	private hideHint(): void {
		this.hintEl?.classList.remove('is-visible');
	}

	/** Instrucción que se muestra al activar el modo, antes del primer clic. */
	private instructionFor(type: string): string {
		return DiagramService.isLinkAnchored(type)
			? 'Hacé clic sobre la línea de la asociación, y después sobre la clase con los atributos.'
			: 'Hacé clic en la clase de origen y después en la de destino.';
	}

	/**
	 * Inicia el modo de creación de relación con un tipo específico
	 */
	startLinkCreation(
		paper: any,
		containerElement: HTMLElement,
		type: string = 'association'
	): void {
		this.paper = paper;
		this.sourceElement = null;
		this.currentType = type;
		// Cambiamos el cursor para indicar el modo de creación
		containerElement.style.cursor = 'crosshair';
		this.showHint(containerElement, this.instructionFor(type));
		// Activamos el listener para la selección de elementos
		this.clickHandler = (cellView: any) => {
			const model = cellView.model;

			if (!this.sourceElement) {
				// Primera selección
				const problem = this.validateSource(model);
				if (problem) {
					this.showHint(containerElement, problem);
					return; // seguimos esperando una selección válida
				}
				this.sourceElement = model;
				this.showHint(
					containerElement,
					DiagramService.isLinkAnchored(this.currentType)
						? 'Ahora hacé clic en la clase que lleva los atributos de la relación.'
						: 'Ahora hacé clic en la clase de destino.'
				);
			} else {
				// Segunda selección, creamos la relación
				const problem = this.validateTarget(model);
				if (problem) {
					this.showHint(containerElement, problem);
					return;
				}
				this.createTypedRelationship(
					this.sourceElement.id,
					model.id,
					this.currentType
				);
				// Limpiamos estado y desactivamos el modo de creación
				this.paper.off('cell:pointerclick', this.clickHandler);
				containerElement.style.cursor = 'default';
				this.sourceElement = null;
				this.clickHandler = null;
				this.hideHint();
			}
		};
		this.paper.on('cell:pointerclick', this.clickHandler);
	}

	/**
	 * Devuelve el motivo por el que la celda no sirve como origen, o `null` si sirve.
	 *
	 * Los conectores responden a `cell:pointerclick` igual que las clases, así que
	 * sin esta comprobación un clic errado sobre una línea crearía, por ejemplo,
	 * una herencia colgada de otra relación.
	 */
	private validateSource(model: any): string | null {
		// Solo se valida el tipo nuevo. Los otros cinco venían funcionando sin
		// comprobaciones y no es este el trabajo para cambiarles el comportamiento.
		if (!DiagramService.isLinkAnchored(this.currentType)) return null;

		if (!model?.isLink?.()) {
			return 'Para una clase de asociación, empezá haciendo clic sobre la línea de la asociación.';
		}
		if (model.get('relationType') !== 'association') {
			return 'Una clase de asociación solo se cuelga de una asociación, no de los otros tipos de relación.';
		}
		return null;
	}

	/** Igual que `validateSource`, para el segundo clic. */
	private validateTarget(model: any): string | null {
		if (!DiagramService.isLinkAnchored(this.currentType)) return null;

		if (!model?.isElement?.()) {
			return 'Ahora elegí la clase que lleva los atributos de la relación.';
		}
		return null;
	}

	/**
	 * Crea una relación del tipo solicitado entre dos elementos
	 */
  private createTypedRelationship(sourceId: string, targetId: string, type: string) {
    this.diagramService.createTypedRelationship(sourceId, targetId, type);
  }


	/**
	 * Cancela el modo de creación de relación
	 */
	cancelLinkCreation(containerElement: HTMLElement): void {
		if (this.paper && this.clickHandler) {
			this.paper.off('cell:pointerclick', this.clickHandler);
			containerElement.style.cursor = 'default';
			this.sourceElement = null;
			this.clickHandler = null;
			this.currentType = 'association';
			this.hideHint();
		}
	}
}
