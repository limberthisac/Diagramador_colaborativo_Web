# Etapa 1: Build con Maven y Java 21
FROM maven:3.9.6-eclipse-temurin-21 AS builder

WORKDIR /app

# Copia los archivos del proyecto al contenedor
COPY pom.xml .
COPY src ./src

# Construye el proyecto sin correr tests
RUN mvn clean package -DskipTests

# Etapa 2: Imagen final para ejecutar el .jar
FROM eclipse-temurin:21-jdk-jammy

# Instalar cliente PostgreSQL 17 desde el repositorio oficial
RUN apt-get update && apt-get install -y curl gnupg2 lsb-release && \
    curl https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && apt-get install -y postgresql-client-17 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia el jar generado desde el contenedor anterior
COPY --from=builder /app/target/*.jar app.jar

# Exponer el puerto 8080 para Railway
EXPOSE 8080



# Comando para ejecutar la aplicación
ENTRYPOINT ["java", "-jar", "app.jar"]
