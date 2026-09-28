import { Component, Output, EventEmitter, PLATFORM_ID, Inject, signal, inject } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { DragDropModule, CdkDragEnd, CdkDragStart } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { DiagramService } from '../../services/diagram/diagram.service';
import { UmlValidationService } from '../../services/colaboration/uml-validation.service';
import { ActivatedRoute, Router } from '@angular/router';
import { SqlExportService } from '../../services/exports/sql-export.service';
import { UmlImageServiceTs } from '../../services/imports/uml-image.service';
import { FrontendGeneratorService } from '../../services/exports/frontend-generator.service';
import { Spinner } from "../components/diagram/spinner/spinner";
import { ChatbotService } from '../../services/IA/chatbot.service';
import { BackendGeneratorService } from '../../services/exports/backend-generator.service';
import { XmiExportService } from '../../services/exports/xmi-export.service';
import { XmiImportService, XmiImportResult } from '../../services/imports/xmi-import.service';


@Component({
  selector: 'app-side-panel',
  imports: [CommonModule, DragDropModule, FormsModule, Spinner],
  templateUrl: './side-panel.html',
  styleUrl: './side-panel.css'
})
export class SidePanel {
  private frontendGeneratorService = inject(FrontendGeneratorService);
  private chatboxService = inject(ChatbotService);
  private backendGeneratorService=inject(BackendGeneratorService);
  @Output() elementDragged = new EventEmitter<CdkDragEnd>();
  @Output() saveClicked = new EventEmitter<void>();
  @Output() generateClicked = new EventEmitter<string>();

  public showActions: boolean = false;
  public showActionsImports: boolean = false;
  public showPalette: boolean = true;

  prompt: string = '';
  validationCollapsed = signal<boolean>(true);
  validationResult = signal<any>(null);
  analyzingModel = signal<boolean>(false);
  roomId: string | null = null;
  copied = signal<boolean>(false);
  recognizing = signal<boolean>(false);
  recognition: any;
  isBrowser: boolean;

  constructor(
    private diagramService: DiagramService,
    private umlValidation: UmlValidationService,
    private router: Router,
    private route: ActivatedRoute,
    private sqlExportService: SqlExportService,
    private umlImageService: UmlImageServiceTs,
    private xmiExportService: XmiExportService,
    private xmiImportService: XmiImportService,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isBrowser = isPlatformBrowser(platformId); // ✅ detecta si estamos en navegador
    this.roomId = this.route.snapshot.paramMap.get('roomId');

    if (this.isBrowser) {
      this.configVoiceRecognition();
    }
  }



  onDragEnded(event: CdkDragEnd) {
    this.elementDragged.emit(event);
    event.source.reset();
  }
  onSaveClicked() {
    this.saveClicked.emit();
  }
  onGenerate() {
    if (this.prompt.trim()) {
      this.generateClicked.emit(this.prompt.trim());
      this.prompt = '';
    }
  }
  // para colapsar el panel
  toggleValidationPanel() {
    this.validationCollapsed.set(!this.validationCollapsed());
  }

  analyzeNow() {
    this.analyzingModel.set(true);
    const umlJson = this.diagramService.exportToJson();
    this.umlValidation.validateModel(umlJson);
  }

  // para recibir resultados desde el padre (diagram)
  updateValidationResult(result: any) {
    this.validationResult.set(result);
    this.analyzingModel.set(false);
    if (this.validationCollapsed()) {
      this.validationCollapsed.set(false); // abrir solo si estaba cerrado
    }
    //this.analyzingModel = false;
  }
  goHome() {
    this.diagramService.clearStorage(); // Limpia el diagrama guardado
    this.diagramService.closeDiagram(this.roomId!); // Cierra conexiones y limpia estado
    this.router.navigate(['/']); // redirige al inicio
  }
  copyRoomCode() {
    const roomId = this.route.snapshot.paramMap.get('roomId');
    if (!roomId) return;

    const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';

    if (isSecure && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(roomId).then(() => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      }).catch(() => this.fallbackCopy(roomId));
    } else {
      this.fallbackCopy(roomId);
    }
  }

  private fallbackCopy(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textarea);
  }

  configVoiceRecognition() {
    if (!this.isBrowser) return;
    this.recognition = null;
    const SpeechRecognition =
      (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;

    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.lang = 'es-ES';
      this.recognition.interimResults = true;
      this.recognition.continuous = false;

      this.recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join('');
        this.prompt = transcript;
      };

      this.recognition.onend = () => {
        this.recognizing.set(true);
      };
    }
  }
  toggleVoiceInput() {
    if (!this.recognition) {
      alert('Tu navegador no soporta reconocimiento de voz');
      return;
    }

    if (this.recognizing()) {
      this.recognition.stop();
      this.recognizing.set(false);
    } else {
      this.recognition.start();
      this.recognizing.set(true);
    }
  }
  exportImage() {
    this.diagramService.exportToImage('diagrama.png');
  }
  exportSql() {
    const umlJson = this.diagramService.exportToJson();
    this.sqlExportService.downloadSql(umlJson, 'diagrama.sql');
  }
  exportEnterpriseArchitect() {
    const umlJson = this.diagramService.exportToJson();
    this.xmiExportService.exportToXmi(umlJson, 'diagrama_ea.xml');
  }

  exportJson() {
    const umlJson = this.diagramService.exportToJson();
    if (!umlJson) return;
    
    // Generar la Colección de Postman
    const postmanCollection = {
      info: {
        name: "API Generada UML",
        description: "Colección generada automáticamente desde el Diagramador UML para probar los endpoints CRUD.",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
      },
      item: umlJson.classes?.map((cls: any) => {
        const classNameLower = cls.name.toLowerCase();
        const baseUrl = "http://localhost:9000/api";
        
        // Generar un cuerpo JSON de ejemplo basado en los atributos
        const exampleBody: any = {};
        if (cls.attributes && Array.isArray(cls.attributes)) {
          cls.attributes.forEach((attr: any) => {
            if (attr.name !== 'id') { // Usualmente no se envía el id en el POST
               if (attr.type.toLowerCase().includes('int') || attr.type.toLowerCase().includes('number')) {
                 exampleBody[attr.name] = 1;
               } else if (attr.type.toLowerCase().includes('boolean')) {
                 exampleBody[attr.name] = true;
               } else {
                 exampleBody[attr.name] = "string";
               }
            }
          });
        }
        const bodyJson = JSON.stringify(exampleBody, null, 4);

        return {
          name: cls.name,
          item: [
            {
              name: `Obtener todos los ${cls.name}s`,
              request: {
                method: "GET",
                url: { raw: `${baseUrl}/${classNameLower}`, host: [baseUrl], path: [classNameLower] }
              }
            },
            {
              name: `Obtener ${cls.name} por ID`,
              request: {
                method: "GET",
                url: { raw: `${baseUrl}/${classNameLower}/1`, host: [baseUrl], path: [classNameLower, "1"] }
              }
            },
            {
              name: `Crear ${cls.name}`,
              request: {
                method: "POST",
                header: [{ key: "Content-Type", value: "application/json" }],
                body: { mode: "raw", raw: bodyJson },
                url: { raw: `${baseUrl}/${classNameLower}`, host: [baseUrl], path: [classNameLower] }
              }
            },
            {
              name: `Actualizar ${cls.name}`,
              request: {
                method: "PUT",
                header: [{ key: "Content-Type", value: "application/json" }],
                body: { mode: "raw", raw: bodyJson },
                url: { raw: `${baseUrl}/${classNameLower}/1`, host: [baseUrl], path: [classNameLower, "1"] }
              }
            },
            {
              name: `Eliminar ${cls.name}`,
              request: {
                method: "DELETE",
                url: { raw: `${baseUrl}/${classNameLower}/1`, host: [baseUrl], path: [classNameLower, "1"] }
              }
            }
          ]
        };
      }) || []
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(postmanCollection, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "coleccion_postman.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  }

  exportSwagger() {
    const umlJson = this.diagramService.exportToJson();
    if (!umlJson) return;
    const baseUrl = "http://localhost:9000/api";
    
    const paths: any = {};
    const schemas: any = {};

    if (umlJson.classes && Array.isArray(umlJson.classes)) {
      umlJson.classes.forEach((cls: any) => {
        const className = cls.name;
        const classNameLower = className.toLowerCase();
        
        // 1. Construir el esquema del modelo
        const properties: any = {};
        if (cls.attributes && Array.isArray(cls.attributes)) {
          cls.attributes.forEach((attr: any) => {
            let type = "string";
            if (attr.type.toLowerCase().includes('int') || attr.type.toLowerCase().includes('number')) {
              type = "integer";
            } else if (attr.type.toLowerCase().includes('boolean')) {
              type = "boolean";
            }
            properties[attr.name] = { type: type };
          });
        }
        
        schemas[className] = {
          type: "object",
          properties: properties
        };

        // 2. Construir las rutas
        const tag = className;
        
        paths[`/api/${classNameLower}`] = {
          get: {
            tags: [tag],
            summary: `Obtener todos los ${className}s`,
            responses: {
              "200": {
                description: "Lista obtenida",
                content: { "application/json": { schema: { type: "array", items: { $ref: `#/components/schemas/${className}` } } } }
              }
            }
          },
          post: {
            tags: [tag],
            summary: `Crear un nuevo ${className}`,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: `#/components/schemas/${className}` } } }
            },
            responses: {
              "201": { description: "Creado exitosamente" }
            }
          }
        };

        paths[`/api/${classNameLower}/{id}`] = {
          get: {
            tags: [tag],
            summary: `Obtener ${className} por ID`,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { "200": { description: "Objeto encontrado", content: { "application/json": { schema: { $ref: `#/components/schemas/${className}` } } } } }
          },
          put: {
            tags: [tag],
            summary: `Actualizar ${className}`,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${className}` } } } },
            responses: { "200": { description: "Actualizado exitosamente" } }
          },
          delete: {
            tags: [tag],
            summary: `Eliminar ${className}`,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { "204": { description: "Eliminado exitosamente" } }
          }
        };
      });
    }

    const swaggerDoc = {
      openapi: "3.0.0",
      info: {
        title: "API Generada UML",
        description: "Documentación Swagger generada automáticamente desde el Diagramador UML.",
        version: "1.0.0"
      },
      servers: [{ url: "http://localhost:9000" }],
      paths: paths,
      components: { schemas: schemas }
    };

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Swagger UI - UML</title>
        <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
      </head>
      <body>
      <div id="swagger-ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" crossorigin></script>
      <script>
        window.onload = () => {
          window.ui = SwaggerUIBundle({
            spec: ${JSON.stringify(swaggerDoc)},
            dom_id: '#swagger-ui',
            validatorUrl: null
          });
        };
      </script>
      </body>
      </html>
    `;

    const newWindow = window.open('', '_blank');
    if (newWindow) {
      newWindow.document.write(htmlContent);
      newWindow.document.close();
    }
  }

  onImportImage(event: Event) {
    this.umlImageService.loading.set(true);
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      console.warn('⚠️ No se seleccionó ningún archivo.');
      return;
    }

    const file = input.files[0];
    console.log(`📸 Imagen seleccionada: ${file.name} | Tamaño: ${(file.size / 1024 / 1024).toFixed(2)} MB | Tipo: ${file.type}`);
    this.analyzingModel.set(true);

    this.umlImageService.analyzeImage(file).subscribe({
      next: (res) => {
        console.log('✅ Respuesta del servidor al subir la imagen:', res);
        const umlJson = res.uml_json || res; // depende de la respuesta del backend
        
        if (umlJson.error) {
           console.error('❌ El servidor devolvió un error interno:', umlJson.error);
           alert('Error al procesar la imagen: ' + umlJson.error);
        } else {
           console.log('📊 JSON UML extraído correctamente:', umlJson);
           this.diagramService.loadFromJson(umlJson);
        }

        this.analyzingModel.set(false);
        this.umlImageService.loading.set(false);
      },
      error: (err) => {
        console.error('❌ Error HTTP al analizar imagen UML:', err);
        alert('Hubo un error de conexión con el servidor al subir la imagen.');
        this.analyzingModel.set(false);
        this.umlImageService.loading.set(false);
      }
    });
  }

  /* ===================== IMPORTACIÓN DE XMI (Enterprise Architect) ===================== */

  /** Diagrama leído y a la espera de que el usuario decida si pisa o suma. */
  pendingImport = signal<XmiImportResult | null>(null);
  /** Resumen de lo que entró, con los avisos de lo que no se pudo representar. */
  importReport = signal<{ classes: number; relationships: number; warnings: string[] } | null>(null);
  importing = signal<boolean>(false);

  async onImportXmi(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Se limpia el input para que elegir el mismo archivo dos veces seguidas
    // vuelva a disparar el evento `change`.
    input.value = '';
    if (!file) return;

    this.importing.set(true);
    try {
      const text = await this.xmiImportService.readFile(file);
      const result = this.xmiImportService.parse(text);

      // Si el lienzo está vacío no hay nada que pisar: se carga directo.
      if (!this.diagramService.getGraph()?.getCells()?.length) {
        this.applyImport(result, true);
      } else {
        this.pendingImport.set(result);
      }
    } catch (err: any) {
      alert(`No se pudo importar el archivo:\n\n${err?.message ?? err}`);
    } finally {
      this.importing.set(false);
    }
  }

  /** Confirma la importación pendiente. `replace` pisa; si no, suma. */
  applyImport(result: XmiImportResult, replace: boolean) {
    this.diagramService.importDiagram(result.diagram, replace);
    this.pendingImport.set(null);
    this.importReport.set({
      classes: result.diagram.classes.length,
      relationships: result.diagram.relationships.length,
      warnings: result.warnings
    });
  }

  cancelImport() {
    this.pendingImport.set(null);
  }

  dismissImportReport() {
    this.importReport.set(null);
  }

  onGenerateFrontend() {
    const umlJson = this.diagramService.exportToJson();
    this.frontendGeneratorService.generateFrontend(umlJson);
  }

  isLoadingImage(): boolean {
    return this.umlImageService.loading();
  }
  isLoadingChatbox(): boolean {
    return this.chatboxService.isLoading();
  }
  isLoadingGeneratefrontend(): boolean {
    return this.frontendGeneratorService.loading();
  }
  isLoadingGenerateBackend():boolean{
    return this.backendGeneratorService.loading();
  }
  


}
