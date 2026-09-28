import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
import collab.routing  # 👈 importa las rutas de tu app

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'diagramador_uml.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            collab.routing.websocket_urlpatterns  # 👈 añade aquí
        )
    ),
})
