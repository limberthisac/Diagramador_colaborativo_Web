FROM python:3.12-slim

# Configuración básica
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

WORKDIR /app
ENV PYTHONPATH=/app
# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y \
    gcc libpq-dev musl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements e instalarlos
COPY requirements.txt /app/
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copiar el resto del proyecto
COPY . /app/
