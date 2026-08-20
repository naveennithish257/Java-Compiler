# JavaForge — Java Compiler Backend

Python HTTP server that compiles and runs Java code using the local JDK.
Deployed on Render.com for use with the Firebase-hosted frontend.

## Local Development

```bash
python server.py
```

Runs on `http://localhost:5050`

## API

### `GET /health`
Returns `{"status": "ok", "jdk": "..."}` if the server is running.

### `POST /execute`
Compiles and runs Java code.

**Request body:**
```json
{
  "code": "public class Main { ... }",
  "stdin": "optional input"
}
```

**Response:**
```json
{
  "stdout": "Hello, World!\n",
  "stderr": "",
  "exitCode": 0
}
```

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect the GitHub repo
4. Render auto-detects the `Dockerfile` and `render.yaml`
5. Deploy — get a URL like `https://javaforge-backend.onrender.com`
