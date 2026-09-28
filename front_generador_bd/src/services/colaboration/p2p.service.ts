import { Injectable, inject } from '@angular/core';
import { SignalingService } from './signaling.service';
import { PresenceService } from './presence.service';
import { IdentityService } from '../session/identity.service';

type Peer = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
};

@Injectable({ providedIn: 'root' })
export class P2PService {
  private peers = new Map<string, Peer>();
  private localId = ''; // mi channel_name (lo asigna el servidor en presence)
  public onData?: (from: string, data: any) => void;

  private presence = inject(PresenceService);
  private identity = inject(IdentityService);

  constructor(private signaling: SignalingService) {}

  init(roomId: string) {
    this.signaling.onMessage = (msg) => this.handleSignaling(msg);
    this.signaling.connect(roomId);
  }

  private iceServers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302'] },
    // TURN opcional si sales a internet:
    // { urls: ['turn:yourturn.com:3478'], username: 'user', credential: 'pass' }
  ];

  private newPeer(remoteId: string, isInitiator: boolean) {
    //console.log(`[P2P] Creando peer con ${remoteId}, initiator=${isInitiator}`);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { pc };
    this.peers.set(remoteId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.sendSignal(remoteId, { type: 'ice', candidate: e.candidate });
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('canvas');
      this.attachDataChannel(remoteId, dc);
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        this.signaling.sendSignal(remoteId, { type: 'offer', sdp: offer });
        //console.log(`[P2P] Offer enviada a ${remoteId}`);
      });
    } else {
      pc.ondatachannel = (ev) => this.attachDataChannel(remoteId, ev.channel);
    }

    return peer;
  }

  private attachDataChannel(remoteId: string, dc: RTCDataChannel) {
    const p = this.peers.get(remoteId);
    if (!p) {
      console.error(`[P2P] Peer no encontrado para ${remoteId}`);
      return;
    }
    p.dc = dc;
    dc.onopen = () => {
      if (this.onData) {
        this.onData(remoteId, { t: 'request_full_state' } as any);
        
      }
    };
    dc.onmessage = (ev) => {
      try {
        this.onData && this.onData(remoteId, JSON.parse(ev.data));
      } catch (e) {
        console.error('[P2P] Error parsing mensaje remoto:', e);
      }
    };
  }


  private async handleSignaling(msg: any) {
    console.log('[P2P] handleSignaling recibió un mensaje del WebSocket:', msg);

    if (msg.type === 'presence') {
      if (msg.peer && !this.localId) {
        this.localId = msg.peer;
      }
      if (msg.action === 'join') {
        // La identidad viaja de polizón en el announce: el consumer de Django
        // relaya el payload tal cual, así que no hace falta tocar el backend.
        this.signaling.broadcast({ type: 'announce', ...this.identity.toAnnouncePayload() });
      }
      if (msg.action === 'leave' && msg.peer) {
        this.dropPeer(msg.peer);
      }
      return;
    }

    if (msg.type === 'broadcast') {
      if (msg.payload?.type === 'announce') {
        const remoteId = msg.from;

        // El registro se actualiza siempre, incluso si el peer ya existe:
        // un re-announce puede traer un nombre nuevo.
        if (remoteId !== this.localId) {
          this.presence.upsert(remoteId, msg.payload.name, msg.payload.color);
        }

        if (this.peers.has(remoteId)) return;

        const isInitiator = this.localId < remoteId;
        this.newPeer(remoteId, isInitiator);
        return;
      } else if (msg.payload?.t && msg.payload.sender !== 'web') {
        console.log('[P2P] ⚡ ¡Llegó una operación directa de Flutter!', msg.payload);
        this.onData && this.onData('flutter_mobile', msg.payload);
        return;
      }
    }

    if (msg.type === 'signal') {
      const remoteId = msg.from;
      let peer = this.peers.get(remoteId);
      if (!peer) peer = this.newPeer(remoteId, false);
      const pc = peer.pc;
      const payload = msg.payload;

      if (payload.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signaling.sendSignal(remoteId, { type: 'answer', sdp: answer });
      } else if (payload.type === 'answer') {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        }
      } else if (payload.type === 'ice' && payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (e) {
          console.warn('[P2P] Error aplicando ICE:', e);
        }
      }
    }
  }

  /** Saca a un peer del registro y libera su conexión.
   *  Antes el `leave` se ignoraba y las RTCPeerConnection quedaban colgadas. */
  private dropPeer(remoteId: string) {
    const peer = this.peers.get(remoteId);
    if (peer) {
      try { peer.dc?.close(); } catch {}
      try { peer.pc.close(); } catch {}
      this.peers.delete(remoteId);
    }
    this.presence.remove(remoteId);
  }

  sendToAll(data: any) {
    const json = JSON.stringify(data);
    for (const [, p] of this.peers) {
      if (p.dc?.readyState === 'open') {
        p.dc.send(json);
      }
    }
    
    // Para que los clientes móviles (Flutter) reciban las operaciones (ya que no usan WebRTC)
    this.signaling.broadcast({ ...data, sender: 'web' });
  }

  closeSocketRTC() {
    // Cerrar WebRTC peers
    for (const [, peer] of this.peers) {
      try {
        peer.dc?.close();
      } catch {}
      try {
        peer.pc.close();
      } catch {}
    }
    this.peers.clear();
    this.localId = '';
    this.presence.reset();

    // Cerrar signaling
    this.signaling.close();
  }

}
