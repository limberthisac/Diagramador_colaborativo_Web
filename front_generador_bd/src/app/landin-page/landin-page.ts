import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { v4 as uuid } from 'uuid';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ThemeService } from '../../services/theme/theme.service';
import { IdentityService, initialsOf, colorOf } from '../../services/session/identity.service';

@Component({
  selector: 'app-landin-page',
  imports: [CommonModule, FormsModule],
  templateUrl: './landin-page.html',
  styleUrls: ['./landin-page.css']
})
export class LandinPage implements OnInit {
  joinCode = '';
  displayName = '';

  /** Se enciende recién cuando el usuario intenta avanzar sin nombre.
   *  Marcar el campo en rojo de entrada sería regañarlo por algo que
   *  todavía no hizo. */
  readonly nameMissing = signal(false);

  private router = inject(Router);
  private identity = inject(IdentityService);
  theme = inject(ThemeService);

  ngOnInit(): void {
    this.identity.restore();
    this.displayName = this.identity.displayName();
  }

  get hasName(): boolean {
    return this.displayName.trim().length > 0;
  }

  get hasCode(): boolean {
    return this.joinCode.trim().length > 0;
  }

  get initials(): string {
    return initialsOf(this.displayName);
  }

  get avatarColor(): string {
    return this.hasName ? colorOf(this.displayName) : 'var(--fg-3)';
  }

  onNameInput(): void {
    if (this.hasName) this.nameMissing.set(false);
  }

  crearNuevoLienzo(): void {
    if (!this.demandName()) return;
    const roomId = uuid();
    this.router.navigate(['/diagram', roomId]);
  }

  unirseAlLienzo(): void {
    if (!this.demandName()) return;
    if (!this.hasCode) return;
    this.router.navigate(['/diagram', this.joinCode.trim()]);
  }

  /** El nombre es obligatorio en ambos caminos: crear y unirse. */
  private demandName(): boolean {
    if (!this.hasName) {
      this.nameMissing.set(true);
      document.getElementById('display-name')?.focus();
      return false;
    }
    this.identity.setName(this.displayName);
    return true;
  }
}
