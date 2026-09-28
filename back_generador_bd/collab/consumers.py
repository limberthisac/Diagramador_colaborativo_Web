import json
from channels.generic.websocket import AsyncWebsocketConsumer
from uml_api.services.services_gemini import call_gemini_analysis
# from uml_api.services.services_groq import call_groq_analysis
import re
class CanvasConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        print("[CanvasConsumer.connect] scope:", self.scope)
        print("[CanvasConsumer.connect] url_route:", self.scope.get("url_route"))
        self.room_name = self.scope["url_route"]["kwargs"]["room_name"]
        self.room_group_name = f"canvas_{self.room_name}"

        # Unir al grupo
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()

        # Notificar presencia
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "presence",
                "action": "join",
                "peer": self.channel_name
            }
        )

    async def disconnect(self, close_code):
        # Salir del grupo
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

        # Notificar salida
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "presence",
                "action": "leave",
                "peer": self.channel_name
            }
        )

    async def receive(self, text_data):
        data = json.loads(text_data)

        # Si es un broadcast → enviar a todos
        if data["type"] == "broadcast":
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "broadcast_message",
                    "from": self.channel_name,
                    "payload": data["payload"]
                }
            )

        # Si es una señal directa → mandar a un peer específico
        elif data["type"] == "signal":
            to = data["to"]
            await self.channel_layer.send(
                to,
                {
                    "type": "signal_message",
                    "from": self.channel_name,
                    "payload": data["payload"]
                }
            )

    # Handlers para los eventos enviados
    async def broadcast_message(self, event):
        await self.send(text_data=json.dumps({
            "type": "broadcast",
            "from": event["from"],
            "payload": event["payload"]
        }))

    async def signal_message(self, event):
        await self.send(text_data=json.dumps({
            "type": "signal",
            "from": event["from"],
            "payload": event["payload"]
        }))

    async def presence(self, event):
        await self.send(text_data=json.dumps({
            "type": "presence",
            "action": event["action"],
            "peer": event["peer"]
        }))



class UMLConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()

    async def receive(self, text_data):
        data = json.loads(text_data)
        action = data.get("action")

        if action == "validate_model":
            uml_json = data.get("uml")

            prompt = f"""
Eres un experto en diseño de bases de datos.
Analiza si las relaciones de este UML son correctas en base a los nombres y atributos.

JSON UML:
{json.dumps(uml_json, indent=2)}
"""

            # Llamar a Gemini
            raw_output = call_gemini_analysis(prompt)
            # raw_output = call_groq_analysis(prompt)

            # 🧹 limpiar markdown (```json ... ```)
            if isinstance(raw_output, str):
                raw_output = re.sub(r"^```json\s*|\s*```$", "", raw_output.strip(), flags=re.MULTILINE)

            try:
                analysis = json.loads(raw_output)
            except Exception:
                analysis = {"error": "Formato inválido", "raw": raw_output}

            # Enviar al front
            await self.send(text_data=json.dumps({
                "action": "validation_result",
                "analysis": analysis
            }, ensure_ascii=False))
