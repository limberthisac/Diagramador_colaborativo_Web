import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { EMPTY, Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class BackupService {
  constructor(private http: HttpClient) {}

    setBackupUml(roomId: string, umlJson: any): Observable<any> {
        if (
        !umlJson ||                                   // null o undefined
        !Array.isArray(umlJson.classes) ||            // no tiene clases
        !Array.isArray(umlJson.relationships) ||      // no tiene relaciones
        (umlJson.classes.length === 0 && umlJson.relationships.length === 0) // está vacío
        ) {
        console.warn('[BackupService] JSON vacío, no se enviará');
        return EMPTY; // 👈 no hace request, solo completa
        }

        const url = `${environment.endpoint_python}api/set_backup_uml/${roomId}/`;
        return this.http.post(url, umlJson);
    }
  getBackup(roomId: string): Observable<any> {
    const url = `${environment.endpoint_python}api/get_backup_uml/${roomId}/`;
    return this.http.get(url);
  }
}
