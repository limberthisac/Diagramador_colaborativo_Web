import { Injectable, signal, inject, PLATFORM_ID, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'uml-theme';

/**
 * Gobierna el tema de toda la app.
 *
 * El tema se aplica como atributo `data-theme` en <html>, que es de donde
 * cuelgan los tokens de styles.css y la variante `dark:` de Tailwind.
 * Por eso alcanza con cambiar el atributo: no hace falta re-renderizar nada.
 *
 * La app corre con SSR, así que todo acceso al DOM y a localStorage va
 * detrás de isPlatformBrowser.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private platformId = inject(PLATFORM_ID);
  private get isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  /** Claro por defecto; el oscuro se elige con el botón de la barra. */
  private readonly _theme = signal<Theme>('light');

  readonly theme = this._theme.asReadonly();
  readonly isDark = computed(() => this._theme() === 'dark');

  /** Llamar una vez al arrancar la app, antes del primer render visible. */
  init(): void {
    if (!this.isBrowser) return;

    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Modo privado o cookies bloqueadas: seguimos con el valor por defecto.
    }

    if (stored === 'light' || stored === 'dark') {
      this._theme.set(stored);
    } else {
      // Sin preferencia guardada mandan el atributo que ya trae el documento
      // (lo pone index.html). Si lo pisáramos con el default, el tema por
      // defecto del HTML sería decorativo.
      const fromDom = document.documentElement.getAttribute('data-theme');
      if (fromDom === 'light' || fromDom === 'dark') {
        this._theme.set(fromDom);
      }
    }

    this.apply(this._theme());
  }

  toggle(): void {
    this.set(this._theme() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this._theme.set(theme);
    if (!this.isBrowser) return;

    this.apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // La preferencia no sobrevive a la sesión, pero el tema igual se aplicó.
    }
  }

  private apply(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
