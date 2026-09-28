import shutil
import tempfile
from pathlib import Path

def compress_folder_to_zip(folder_path):
    """Comprime una carpeta en un archivo ZIP temporal y devuelve su ruta."""
    base_name = tempfile.mktemp()
    zip_path = shutil.make_archive(base_name, 'zip', folder_path)
    return Path(zip_path)
