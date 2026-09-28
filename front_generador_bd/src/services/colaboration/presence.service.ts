import { Injectable, signal, computed, inject } from '@angular/core';
import { IdentityService, initialsOf, colorOf } from '../session/identity.service';

export interface Peer {
  id: string;        // channel_name que asigna Django Channels
  name: string;
  color: string;
  initials: string;
  isSelf: boolean;
}

/**
 * Registro de quién está en la sala.
 *
 * El backend sólo informa `presence` join/leave con un channel_name opaco:
 * no hay identidad de usuario porque la app no tiene autenticación. El
 * nombre viaja dentro del payload del `announce`, que el consumer de Django
 * relaya sin inspeccionar. Por eso este registro se arma entero en el cliente.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private identity = inject(IdentityService);

  private readonly _remote = signal<Map<string, Peer>>(new Map());

  /** Yo primero, después el resto, para que mi avatar no salte de lugar. */
  readonly peers = computed<Peer[]>(() => {
    const me: Peer = {
      id: 'self',
      name: this.identity.displayName() || 'Tú',
      color: this.identity.color(),
      initials: this.identity.initials(),
      isSelf: true
    };
    return [me, ...Array.from(this._remote().values())];
  });

  readonly count = computed(() => this._remote().size + 1);

  /** Registra o actualiza un peer a partir de su `announce`. */
  upsert(id: string, name?: string, color?: string): void {
    const safeName = (name || '').trim() || 'Invitado';
    const next = new Map(this._remote());
    next.set(id, {
      id,
      name: safeName,
      color: color || colorOf(safeName),
      initials: initialsOf(safeName),
      isSelf: false
    });
    this._remote.set(next);
  }

  remove(id: string): void {
    if (!this._remote().has(id)) return;
    const next = new Map(this._remote());
    next.delete(id);
    this._remote.set(next);
  }

  reset(): void {
    this._remote.set(new Map());
  }
}
