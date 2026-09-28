import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
type Msg =
  | { type: 'presence'; action: 'join' | 'leave'; peer: string }
  | { type: 'signal'; from: string; payload: any }
  | { type: 'broadcast'; from: string; payload: any };

@Injectable({ providedIn: 'root' })
export class SignalingService {
  private socket!: WebSocket;
  private _roomId!: string;
  public onMessage?: (msg: Msg) => void;

  connect(roomId: string) {
    this._roomId = roomId;

    // Detecta ws:// o wss:// correctamente
    //const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    //const wsUrl = `${scheme}://${location.hostname}:8000/ws/canvas/${roomId}/`;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host =
      window.location.protocol === 'https:'
        ? environment.WebSocket_python
        : window.location.hostname;

    const port =

      //   window.location.protocol === 'https:'
      //     ? ''
      //     : environment.wsPort
      //       ? `:${environment.wsPort}`
      //       : '';
      // const wsUrl = `${scheme}://${host}${port}${environment.wsPath}${roomId}/`;

      window.location.protocol === 'https:'
        ? ''
        : environment.wsPort
          ? `:${environment.wsPort}`
          : '';
    const wsUrl = `${scheme}://${host}${port}${environment.wsPath}${roomId}/`;

    console.log('[Signaling] Connecting to', wsUrl);
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      console.log('[Signaling] Connected to', wsUrl);
      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift();
        if (msg) this.socket.send(msg);
      }
    };
    this.socket.onmessage = (ev) => {
      try {
        const msg: Msg = JSON.parse(ev.data);
        if (this.onMessage) this.onMessage(msg);
      } catch (e) {
        console.error('[Signaling] Error parsing message', e);
      }
    };
    this.socket.onclose = () => console.log('[Signaling] Disconnected');
  }

  private messageQueue: string[] = [];

  sendSignal(to: string, payload: any) {
    this._safeSend(JSON.stringify({ type: 'signal', to, payload }));
  }

  broadcast(payload: any) {
    this._safeSend(JSON.stringify({ type: 'broadcast', payload }));
  }

  private _safeSend(data: string) {
    if (!this.socket) return;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.messageQueue.push(data);
    } else {
      console.warn('[Signaling] Socket is not open or connecting. State:', this.socket.readyState);
    }
  }

  close() {
    this.socket?.close();
  }
}
