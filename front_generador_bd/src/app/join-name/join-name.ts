import { Component, inject, signal, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IdentityService, initialsOf, colorOf } from '../../services/session/identity.service';

/**
 * Pide el nombre a quien entra directo a una sala por enlace compartido.
 *
 * El enlace de "Compartir" apunta a /diagram/:roomId, que se saltea el
 * landing donde normalmente se pide la identidad. Sin esto, quien llega
 * por enlace aparecería como "?" para el resto de la sala.
 */
@Component({
  selector: 'app-join-name',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './join-name.html',
  styleUrls: ['./join-name.css']
})
export class JoinName {
  name = '';
  readonly missing = signal(false);
  readonly confirmed = output<void>();

  private identity = inject(IdentityService);

  get hasName(): boolean {
    return this.name.trim().length > 0;
  }

  get initials(): string {
    return initialsOf(this.name);
  }

  get avatarColor(): string {
    return this.hasName ? colorOf(this.name) : 'var(--fg-3)';
  }

  onInput(): void {
    if (this.hasName) this.missing.set(false);
  }

  confirm(): void {
    if (!this.hasName) {
      this.missing.set(true);
      return;
    }
    this.identity.setName(this.name);
    this.confirmed.emit();
  }
}
