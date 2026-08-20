# Use Python slim image as base
FROM python:3.12-slim

# Install OpenJDK 21 (headless, no GUI components needed)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Verify java installation
RUN java -version && javac -version

# Set working directory
WORKDIR /app

# Copy the backend server
COPY server.py .

# Cloud Run sets PORT; expose it
EXPOSE 8080

# Run the server
CMD ["python", "server.py"]
