import express from 'express';
import cors from 'cors';
import { spawn, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Enable CORS and JSON body parsing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '1mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get installed JDK version
function getJdkVersion() {
  return new Promise((resolve) => {
    execFile('java', ['-version'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        resolve('JDK not detected');
        return;
      }
      const output = stdout || stderr || '';
      const firstLine = output.split('\n')[0]?.trim() || 'unknown';
      resolve(firstLine);
    });
  });
}

// Clean temporary directory paths from compiler output
function cleanPaths(text, tmpdir) {
  if (!text) return '';
  const sep = path.sep;
  return text
    .split(tmpdir + sep).join('')
    .split(tmpdir + '/').join('')
    .split(tmpdir).join('');
}

// GET /health endpoint
app.get('/health', async (req, res) => {
  const jdk = await getJdkVersion();
  res.json({
    status: 'ok',
    jdk
  });
});

// Run command with input and timeout
function runProcess(cmd, args, input = '', cwd = '', timeoutMs = 30000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    let child;
    try {
      child = spawn(cmd, args, { cwd });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err.code === 'ENOENT'
          ? 'javac/java not found. Make sure JDK is installed and in PATH.'
          : String(err),
        exitCode: -1
      });
      return;
    }

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve({
        stdout,
        stderr: 'Execution timed out (30s limit)',
        exitCode: -1
      });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.code === 'ENOENT'
          ? 'javac/java not found. Make sure JDK is installed and in PATH.'
          : String(err),
        exitCode: -1
      });
    });

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString('utf-8');
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString('utf-8');
      });
    }

    if (input && child.stdin) {
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (_) {}
    } else if (child.stdin) {
      try {
        child.stdin.end();
      } catch (_) {}
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0
      });
    });
  });
}

// POST /execute endpoint
app.post('/execute', async (req, res) => {
  const { code = '', stdin = '' } = req.body || {};

  // Extract public class name (fallback: Main)
  const match = code.match(/public\s+class\s+(\w+)/);
  const className = match ? match[1] : 'Main';

  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javaforge-'));
    const javaFilePath = path.join(tmpDir, `${className}.java`);
    fs.writeFileSync(javaFilePath, code, 'utf-8');

    // 1. Compile with javac
    const compileResult = await runProcess('javac', [javaFilePath], '', tmpDir, 30000);
    if (compileResult.exitCode !== 0) {
      return res.json({
        stdout: '',
        stderr: cleanPaths(compileResult.stderr, tmpDir),
        exitCode: compileResult.exitCode
      });
    }

    // 2. Run with java
    const runResult = await runProcess('java', ['-cp', tmpDir, className], stdin, tmpDir, 30000);
    return res.json({
      stdout: runResult.stdout,
      stderr: cleanPaths(runResult.stderr, tmpDir),
      exitCode: runResult.exitCode
    });
  } catch (err) {
    return res.json({
      stdout: '',
      stderr: String(err),
      exitCode: -1
    });
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
});

// Fallback to index.html for all other GET routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`[JavaForge] Server running on http://${HOST}:${PORT}`);
});
