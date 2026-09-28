import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class UmlValidationService {
  private socket?: WebSocket;
  private responseTimeout?: ReturnType<typeof setTimeout>;
  private onError?: (message: string) => void;
  private awaitingResponse = false;

  connect(onResult: (data: any) => void, onError: (message: string) => void) {
    this.onError = onError;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host =
      window.location.protocol === 'https:'
        ? environment.WebSocket_python
        : window.location.hostname;

    const port =
      window.location.protocol === 'https:'
        ? ''
        : environment.wsPort
          ? `:${environment.wsPort}`
          : '';

    this.socket = new WebSocket(`${scheme}://${host}${port}/ws/uml/`);

    this.socket.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.action === 'validation_result') {
          this.clearResponseTimeout();
          this.awaitingResponse = false;
          onResult(data);
        }
      } catch (e) {
        console.error('Error parseando mensaje de validación', e);
        this.failPendingValidation('El servidor envió una respuesta de validación inválida.');
      }
    };

    this.socket.onerror = () => {
      this.failPendingValidation('No se pudo establecer la conexión con el servidor de análisis.');
    };

    this.socket.onclose = () => {
      this.failPendingValidation('La conexión con el servidor de análisis se cerró.');
    };
  }


  validateModel(umlJson: any): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('[UML Validation] WebSocket no conectado todavía');
      return false;
    }

    const payload = {
      action: 'validate_model',
      uml: umlJson
    };
    try {
      this.socket.send(JSON.stringify(payload));
      this.awaitingResponse = true;
      this.clearResponseTimeout();
      this.responseTimeout = setTimeout(() => {
        this.failPendingValidation('La IA tardó demasiado en analizar el modelo. Inténtalo nuevamente.');
      }, 90000);
      return true;
    } catch (error) {
      console.error('[UML Validation] No se pudo enviar la solicitud', error);
      return false;
    }
  }

  private clearResponseTimeout(): void {
    if (this.responseTimeout) {
      clearTimeout(this.responseTimeout);
      this.responseTimeout = undefined;
    }
  }

  private failPendingValidation(message: string): void {
    if (!this.awaitingResponse) return;
    this.awaitingResponse = false;
    this.clearResponseTimeout();
    this.onError?.(message);
  }
}
