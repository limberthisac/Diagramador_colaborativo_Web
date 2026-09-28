import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },

  // Tu ruta dinámica: ¡NO prerender!
  { path: 'diagram/:roomId', renderMode: RenderMode.Server }, // o RenderMode.Client

  // Fallback para el resto
  { path: '**', renderMode: RenderMode.Server },
];
