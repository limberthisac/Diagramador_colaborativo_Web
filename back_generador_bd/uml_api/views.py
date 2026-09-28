import tempfile
from django.http import FileResponse
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import BackupUML
import json
import re

from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import MultiPartParser, FormParser
import base64
from io import BytesIO
from PIL import Image
from .services.services_gemini import call_gemini, call_gemini_from_image
# from .services.services_groq import call_groq, call_groq_from_image


from pathlib import Path
from .services.flutter_generator import FlutterCRUDGenerator
from .utils.zip_utils import compress_folder_to_zip


class GenerateUMLView(APIView):
    def post(self, request):
        prompt = request.data.get("prompt")
        if not prompt:
            return Response({"error": "El campo 'prompt' es requerido"}, status=status.HTTP_400_BAD_REQUEST)

        output = call_gemini(prompt)
        # output = call_groq(prompt)

        # 🧹 Limpiar bloque de código Markdown si viene envuelto en ```json ... ```
        if isinstance(output, str):
            output = re.sub(r"^```json\s*|\s*```$", "",
                            output.strip(), flags=re.MULTILINE)

        try:
            parsed_json = json.loads(output)
        except Exception as e:
            return Response({
                "error": "Gemini devolvió un formato inválido",
                "raw": output,
                "exception": str(e)
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response(parsed_json, status=status.HTTP_200_OK)


@api_view(['POST'])
def set_backupUML(request, room_id):
    if not room_id:
        return Response({"error": "Se requiere el campo 'room_id'"}, status=status.HTTP_400_BAD_REQUEST)

    data = request.data

    try:
        # Buscar si ya existe
        uml_backup, created = BackupUML.objects.update_or_create(
            room_id=room_id,
            defaults={"data": data}
        )
    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

    return Response({
        "message": "UML creado con éxito" if created else "UML actualizado con éxito",
        "room_id": str(uml_backup.room_id),
        "data": uml_backup.data
    }, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


@api_view(['GET'])
def get_backupUML(request, room_id):
    if not room_id:
        return Response({"error": "Se requiere el campo 'room_id'"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        diagrama = BackupUML.objects.get(room_id=room_id)
    except BackupUML.DoesNotExist:
        return Response({"error": "No existe un diagrama con ese ID"}, status=status.HTTP_404_NOT_FOUND)

    # ✅ Devolver el JSON guardado exactamente como está en la BD
    return Response(diagrama.data, status=status.HTTP_200_OK)


@api_view(['POST'])
@parser_classes([MultiPartParser, FormParser])
def analyze_uml_image(request):
    """
    Espera un archivo de imagen (PNG o JPG).
    """
    image_file = request.FILES.get("image")

    if not image_file:
        return Response({"error": "Debe enviar un archivo 'image'"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        # Abrir la imagen con Pillow para comprimirla antes de enviarla
        img = Image.open(image_file)
        
        # Convertir a RGB para evitar problemas con transparencias (PNG a JPEG)
        if img.mode != 'RGB':
            img = img.convert('RGB')
            
        # Redimensionar (máximo 1024x1024) manteniendo la proporción
        img.thumbnail((1024, 1024))
        
        # Guardar la imagen comprimida en memoria
        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=85)
        
        # Convertir a Base64 (ahora pesará muchísimo menos)
        image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        mime_type = "image/jpeg"
    except Exception as e:
        return Response({"error": f"Error procesando imagen: {str(e)}"}, status=status.HTTP_400_BAD_REQUEST)

    # Llamar al servicio Gemini
    result = call_gemini_from_image(
        image_base64, mime_type=mime_type
    )
    # result = call_groq_from_image(image_base64, mime_type=mime_type)

    # Intentar parsear el resultado JSON
    try:
        parsed = json.loads(result) if isinstance(result, str) else result
    except Exception:
        parsed = {"raw": result, "error": "No se pudo parsear correctamente"}

    return Response({"uml_json": parsed}, status=status.HTTP_200_OK)


@api_view(["POST"])
def generar_flutter(request):
    """
    Genera un proyecto Flutter completo a partir de un JSON UML.
    Devuelve un ZIP descargable.
    """
    try:
        uml_json = request.data
        if not uml_json.get("classes"):
            return Response({"error": "El JSON UML debe contener 'classes'."}, status=400)

        # Crear carpeta temporal
        temp_dir = Path(tempfile.mkdtemp())

        # Generar el proyecto Flutter
        generator = FlutterCRUDGenerator(uml_json)
        generator.generate_project(output_dir=temp_dir / "flutter_app")

        # Comprimir el resultado
        zip_path = compress_folder_to_zip(temp_dir / "flutter_app")

        # Devolver como archivo descargable
        response = FileResponse(
            open(zip_path, "rb"),
            as_attachment=True,
            filename="flutter_project.zip"
        )
        return response

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
