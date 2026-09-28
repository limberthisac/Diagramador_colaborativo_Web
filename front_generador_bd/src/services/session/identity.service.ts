import { Injectable, signal, inject, PLATFORM_ID, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

const STORAGE_KEY = 'uml-display-name';

/** Colores de avatar. Se elige uno por hash del nombre, no al azar,
 *  para que la misma persona conserve su color entre sesiones. */
const AVATAR_COLORS = ['#3b82f6', '#f59e0b', '#22c55e', '#a855f7', '#ef4444'];

/**
 * Identidad del participante dentro de una sala.
 *
 * La app no tiene autenticación: el nombre es auto-declarado y viaja
 * dentro del payload del `announce` que ya relaya el backend sin
 * inspeccionarlo. Por eso esto vive entero en el frontend.
 */
@Injectable({ providedIn: 'root' })
export class IdentityService {
  private platformId = inject(PLATFORM_ID);
  private get isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  private readonly _displayName = signal<string>('');

  readonly displayName = this._displayName.asReadonly();
  readonly hasName = computed(() => this._displayName().trim().length > 0);
  readonly initials = computed(() => initialsOf(this._displayName()));
  readonly color = computed(() => colorOf(this._displayName()));

  /** Recupera el nombre de una visita anterior, si lo hay. */
  restore(): void {
    if (!this.isBrowser) return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) this._displayName.set(stored);
    } catch {
      // Sin almacenamiento: el usuario simplemente vuelve a escribirlo.
    }
  }

  setName(name: string): void {
    const clean = name.trim().slice(0, 24);
    this._displayName.set(clean);
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, clean);
    } catch {
      // No persiste, pero la sesión actual ya tiene el nombre.
    }
  }

  /** Lo que se anuncia a los demás peers de la sala. */
  toAnnouncePayload(): { name: string; color: string } {
    return { name: this._displayName(), color: this.color() };
  }
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function colorOf(name: string): string {
  const n = name.trim();
  if (!n) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < n.length; i++) {
    h = (h * 31 + n.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
