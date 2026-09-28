import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { saveAs } from 'file-saver';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class BackendGeneratorService {
  public loading=signal<boolean>(false);// estando para ver el estado de carga

  constructor(private http: HttpClient) {}

  /**
   * Envía el JSON UML al backend y descarga el zip generado
   */
  generateBackend(json: any, filename: string = 'backend.zip') {
    this.loading.set(true);
    this.http.post(`${environment.endpoint_java}generate`, json, {
      responseType: 'blob'
    }).subscribe({
      next: (zipBlob: Blob) => {
        saveAs(zipBlob, filename);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error generando backend:', err);
        this.loading.set(false);
      }
    });
  }
}
