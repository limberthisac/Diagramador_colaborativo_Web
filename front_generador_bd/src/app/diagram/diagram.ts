import { AfterViewInit, Component, ElementRef, HostListener, Inject, NgZone, PLATFORM_ID, ViewChild, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CdkDragEnd, CdkDropListGroup, CdkDropList } from '@angular/cdk/drag-drop';
import { SidePanel } from "../side-panel/side-panel";
import { DiagramService } from '../../services/diagram/diagram.service';
import { FallbackService } from '../../services/diagram/fallback.service';
import { RelationshipService } from '../../services/diagram/relationship.service';
import { UmlClass, Attribute, Method } from '../../models/uml-class.model';
import { DiagramExportService } from '../../services/exports/diagram-export.service';
import { BackendGeneratorService } from '../../services/exports/backend-generator.service';
import { ChatbotService } from '../../services/IA/chatbot.service';
import { UmlValidationService } from '../../services/colaboration/uml-validation.service';
import { ActivatedRoute } from '@angular/router';
import { TopBar } from '../top-bar/top-bar';
import { JoinName } from '../join-name/join-name';
import { IdentityService } from '../../services/session/identity.service';

@Component({
  selector: 'app-diagram',
  standalone: true,
  templateUrl: './diagram.html',
  styleUrls: ['./diagram.css'],
  imports: [SidePanel, CdkDropListGroup, CdkDropList, TopBar, JoinName]
})
export class Diagram implements AfterViewInit {
  @ViewChild('paperContainer', { static: true }) paperContainer!: ElementRef;
  @ViewChild(SidePanel) sidePanel!: SidePanel;

  /** Se muestra en la barra superior y da el enlace que se comparte. */
  roomId = '';

  private identity = inject(IdentityService);

  /** Quien llega por enlace compartido se saltea el landing y no tiene
   *  nombre. En ese caso se le pide acá antes de dejarlo entrar. */
  readonly needsName = signal(false);

  onNameConfirmed(): void {
    this.needsName.set(false);
  }

  private lastMousePos: { x: number; y: number } | null = null;
  
  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private ngZone: NgZone,
    private diagramService: DiagramService,
    private fallbackService: FallbackService,
    private relationshipService: RelationshipService,
    private exportService: DiagramExportService,
    private backendGen: BackendGeneratorService,
    private chatbot: ChatbotService,
    private umlValidation: UmlValidationService,
    private route: ActivatedRoute
  ) {}
  
  async ngAfterViewInit(): Promise<void> {
    this.roomId = this.route.snapshot.paramMap.get('roomId') || 'default-room';

    if (isPlatformBrowser(this.platformId)) {
      this.identity.restore();
      this.needsName.set(!this.identity.hasName());

      this.ngZone.run(async () => {
        try {
          const roomId = this.roomId;
          await this.diagramService.initialize(this.paperContainer.nativeElement, roomId);
          
          this.sidePanel.elementDragged.subscribe((event: CdkDragEnd) => {
            this.onDragEnded(event);
          });

          this.sidePanel.saveClicked.subscribe(() => this.saveDiagram());

          this.sidePanel.generateClicked.subscribe((prompt: string) => {
            this.generateFromPrompt(prompt);
          });
          
          this.umlValidation.connect((result) => {
            this.sidePanel.updateValidationResult(result);
          });
          
          console.log('Diagrama inicializado correctamente');
        } catch (error) {
          console.error('Error al inicializar el diagrama:', error);
        }
      });
    }
      // Guardar la posición del mouse sobre el canvas
      if (this.paperContainer?.nativeElement) {
        this.paperContainer.nativeElement.addEventListener('mousemove', (evt: MouseEvent) => {
          const rect = this.paperContainer.nativeElement.getBoundingClientRect();
          this.lastMousePos = {
            x: evt.clientX - rect.left,
            y: evt.clientY - rect.top
          };
        });
        // Si el mouse sale del canvas, limpiar la posición
        this.paperContainer.nativeElement.addEventListener('mouseleave', () => {
          this.lastMousePos = null;
        });
      }
  }
  saveDiagram() {
    const json = this.exportService.export(this.diagramService.getGraph());
    console.log('JSON exportado:', JSON.stringify(json, null, 2));

    // luego lo puedes enviar a backend
    this.backendGen.generateBackend(json, 'mi-backend.zip');
  }

  generateFromPrompt(prompt: string) {
    this.chatbot.isLoading.set(true);
    this.chatbot.generateDiagram(prompt).subscribe({
      next: (json) => {
        console.log('Respuesta del chatbot:', json);
        this.diagramService.loadFromJson(json,true);
        this.chatbot.isLoading.set(false);
      },
      error: (err) => {
        console.error('Error al generar diagrama desde chatbot', err);
        this.chatbot.isLoading.set(false);
      }
    });
  }

  @HostListener('document:keydown', ['$event'])
  handleEscape(event: KeyboardEvent) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.diagramService.deleteSelected();
    }
    if (event.key === 'Escape') {
      this.diagramService.clearSelection();
    }
      // Atajos globales copiar, pegar, duplicar, cortar
      if (event.ctrlKey && event.key === 'c') {
        this.diagramService.clipboard = this.diagramService['copyUmlClass']?.(this.diagramService['selectedCell']);
        this.diagramService.clearSelection();
        event.preventDefault();
      }
        if (event.ctrlKey && event.key === 'v') {
          this.diagramService.clearSelection();
          if (this.diagramService.clipboard) {
            // Si hay posición de mouse, pegar ahí
            if (this.lastMousePos) {
              const model = { ...this.diagramService.clipboard, position: { ...this.lastMousePos } };
              this.diagramService['pasteUmlClass']?.(model);
            } else {
              this.diagramService['pasteUmlClass']?.(this.diagramService.clipboard);
            }
            this.diagramService.clearSelection();
          }
          event.preventDefault();
        }
      if (event.ctrlKey && event.key === 'x') {
        this.diagramService.clipboard = this.diagramService['copyUmlClass']?.(this.diagramService['selectedCell']);
        this.diagramService.deleteSelected();
        this.diagramService.clearSelection();
        event.preventDefault();
      }
      if (event.ctrlKey && event.key === 'd') {
        const clone = this.diagramService['copyUmlClass']?.(this.diagramService['selectedCell']);
        this.diagramService.clearSelection();
        this.diagramService['pasteUmlClass']?.(clone);
        event.preventDefault();
      }
  }
  
  @HostListener('window:resize')
  onResize() {
    if (this.diagramService['paper'] && this.paperContainer) {
      const rect = this.paperContainer.nativeElement.getBoundingClientRect();
      this.diagramService['paper'].setDimensions(rect.width, rect.height);
    }
  }


  onDragEnded(event: CdkDragEnd) {
    // Ejecutamos dentro de ngZone para asegurar la detección de cambios
    this.ngZone.run(() => {
      const type = (event.source.data as any).type;
      const { x, y } = event.dropPoint; // posición absoluta en pantalla

      // Ajustar posición relativa al canvas
      const rect = this.paperContainer.nativeElement.getBoundingClientRect();
      const pos = { x: x - rect.left, y: y - rect.top };

      console.log('Elemento arrastrado:', type, 'Posición:', pos);

      if (type === 'class') {
        try {
          // Crear un modelo de clase UML
          const umlClassModel: UmlClass = {
            name: 'Entidad',
            position: pos,
            size: { width: 180, height: 110 },
            attributes: [
              { name: 'id', type: 'int' },
              { name: 'nombre', type: 'string' }
            ],
            methods: [
              { name: 'crear' },
              { name: 'eliminar' }
            ]
          };
          
          // Usar el servicio para crear la clase UML
          this.diagramService.createUmlClass(umlClassModel);
          console.log('Entidad UML creada correctamente');
        } catch (error) {
          console.error('Error al crear el elemento:', error);
          
          // Si falla, usamos el fallback HTML
          const fallbackClass: UmlClass = {
            name: 'Entidad',
            position: pos,
            attributes: [
              { name: 'id', type: 'int' },
              { name: 'nombre', type: 'string' }
            ],
            methods: [
              { name: 'crear' },
              { name: 'eliminar' }
            ]
          };
          
          this.fallbackService.createFallbackElement(
            this.paperContainer.nativeElement, 
            fallbackClass
          );
        }
      }

      if (['association','generalization','aggregation','composition','dependency','associationClass'].includes(type)) {
        this.relationshipService.startLinkCreation(
          this.diagramService['paper'],
          this.paperContainer.nativeElement,
          type // 👈 pasamos el tipo
        );
        console.log(`Modo de creación de relación activado: ${type}`);
      }

    });
  }
  zoomIn() {
    this.diagramService.zoomIn();
  }

  zoomOut() {
    this.diagramService.zoomOut();
  }

  resetZoom() {
    this.diagramService.resetZoom();
  }
}

