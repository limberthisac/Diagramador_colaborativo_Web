import { Routes } from '@angular/router';
import { Diagram } from './diagram/diagram';
import { LandinPage } from './landin-page/landin-page';
export const routes: Routes = [ 
  { path: '', component: LandinPage },  
  { 
    path: 'diagram/:roomId', 
    component: Diagram,
  },
  { path: '**', redirectTo: '' }
];  
