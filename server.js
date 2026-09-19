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
let localJdkAvailable = false;
let localJdkVersion = 'JDK not detected';

function detectJdk() {
  return new Promise((resolve) => {
    execFile('java', ['-version'], { timeout: 4000 }, (error, stdout, stderr) => {
      if (error) {
        localJdkAvailable = false;
        localJdkVersion = 'JDK not detected';
        resolve(false);
        return;
      }
      localJdkAvailable = true;
      const output = stdout || stderr || '';
      localJdkVersion = output.split('\n')[0]?.trim() || 'OpenJDK';
      resolve(true);
    });
  });
}

// Initial detection
detectJdk();

// Clean temporary directory paths from compiler output
function cleanPaths(text, tmpdir) {
  if (!text) return '';
  const sep = path.sep;
  return text
    .split(tmpdir + sep).join('')
    .split(tmpdir + '/').join('')
    .split(tmpdir).join('');
}

// Helper to mask comments and string/char literals while preserving line lengths
function stripCommentsAndStrings(code) {
  if (!code) return '';
  let result = '';
  let inString = false;
  let inChar = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += '\n';
      } else {
        result += ' ';
      }
    } else if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        result += '  ';
        i++;
      } else {
        result += (c === '\n' ? '\n' : ' ');
      }
    } else if (inString) {
      if (c === '\\') {
        result += '  ';
        i++;
      } else if (c === '"') {
        inString = false;
        result += ' ';
      } else {
        result += (c === '\n' ? '\n' : ' ');
      }
    } else if (inChar) {
      if (c === '\\') {
        result += '  ';
        i++;
      } else if (c === "'") {
        inChar = false;
        result += ' ';
      } else {
        result += (c === '\n' ? '\n' : ' ');
      }
    } else {
      if (c === '/' && next === '/') {
        inLineComment = true;
        result += '  ';
        i++;
      } else if (c === '/' && next === '*') {
        inBlockComment = true;
        result += '  ';
        i++;
      } else if (c === '"') {
        inString = true;
        result += ' ';
      } else if (c === "'") {
        inChar = true;
        result += ' ';
      } else {
        result += c;
      }
    }
  }
  return result;
}

// Robust class name extraction: identifies top-level class enclosing the main method
function extractJavaClassName(code) {
  if (!code) return 'Main';
  const clean = stripCommentsAndStrings(code);
  let depth = 0;
  const topLevelTypes = [];
  let currentTopLevel = null;

  const regex = /\{|\}|(?:^|\s)(public\s+)?(class|record|enum|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)|(?:public\s+static|static\s+public)\s+void\s+main\s*\(/g;
  let match;

  while ((match = regex.exec(clean)) !== null) {
    const token = match[0].trim();
    if (token === '{') {
      depth++;
    } else if (token === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        currentTopLevel = null;
      }
    } else if (match[2]) {
      if (depth === 0) {
        const isPublic = !!match[1];
        const typeKind = match[2];
        const name = match[3];
        currentTopLevel = { name, isPublic, typeKind, hasMain: false, index: match.index };
        topLevelTypes.push(currentTopLevel);
      }
    } else if (token.includes('main')) {
      if (currentTopLevel && depth === 1) {
        currentTopLevel.hasMain = true;
      }
    }
  }

  // 1. If any top-level type has main, select it
  const withMain = topLevelTypes.find(t => t.hasMain);
  if (withMain) return withMain.name;

  // 2. If any top-level type is explicitly public, select it
  const pub = topLevelTypes.find(t => t.isPublic);
  if (pub) return pub.name;

  // 3. Fallback to first declared top-level type
  if (topLevelTypes.length > 0) {
    return topLevelTypes[0].name;
  }

  return 'Main';
}

// Prepare Java source code: handles packages, raw snippets, and multi-class declarations
function prepareJavaCode(code) {
  if (!code) return { code: '', className: 'Main', wrapped: false, wrapperOffset: 0 };

  const cleanCode = stripCommentsAndStrings(code);
  const hasClassDeclaration = /(?:^|\s)(?:class|record|enum|interface)\s+[A-Za-z_$]/.test(cleanCode);
  const hasMain = /(?:public\s+static|static\s+public)\s+void\s+main\s*\(/.test(cleanCode);

  // If user provided raw statements without a class (e.g. System.out.println(...))
  if (!hasClassDeclaration && !hasMain && cleanCode.trim().length > 0) {
    const lines = code.split('\n');
    const importLines = [];
    const bodyLines = [];
    for (const line of lines) {
      if (/^\s*import\s+[^;]+;/.test(line)) {
        importLines.push(line);
      } else {
        bodyLines.push(line);
      }
    }
    const header = `import java.util.*;\nimport java.io.*;\nimport java.math.*;\n${importLines.length ? importLines.join('\n') + '\n' : ''}public class Main {\n    public static void main(String[] args) throws Exception {\n`;
    const wrapperOffset = header.split('\n').length - 1;
    const wrappedCode = `${header}${bodyLines.map(l => '        ' + l).join('\n')}\n    }\n}`;
    return { code: wrappedCode, className: 'Main', wrapped: true, wrapperOffset };
  }

  // Comment out package declarations to preserve exact line numbering
  let sanitizedCode = code.replace(/^(\s*package\s+[^;]+;)/gm, '// $1');
  const className = extractJavaClassName(sanitizedCode);

  // In standard Java, only ONE top-level type can be public.
  // Parse top-level types (depth === 0) and strip 'public' from non-main top-level types.
  let depth = 0;
  const nonMainPublicRanges = [];
  const regex = /\{|\}|(?:^|\s)(public\s+)?(class|record|enum|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match;

  while ((match = regex.exec(cleanCode)) !== null) {
    const token = match[0].trim();
    if (token === '{') {
      depth++;
    } else if (token === '}') {
      depth = Math.max(0, depth - 1);
    } else if (match[2] && depth === 0) {
      const isPublic = !!match[1];
      const name = match[3];
      if (isPublic && name !== className) {
        const fullMatch = match[0];
        const publicOffset = fullMatch.indexOf('public');
        const start = match.index + publicOffset;
        nonMainPublicRanges.push({ start, end: start + 7 });
      }
    }
  }

  if (nonMainPublicRanges.length > 0) {
    nonMainPublicRanges.sort((a, b) => b.start - a.start);
    for (const range of nonMainPublicRanges) {
      sanitizedCode = sanitizedCode.slice(0, range.start) + sanitizedCode.slice(range.end);
    }
  }

  return { code: sanitizedCode, className, wrapped: false, wrapperOffset: 0 };
}

const CLOUD_COMPILER_URL = 'https://java-compiler-suro.onrender.com/execute';

// Ensure executable for cloud runner which specifically runs 'java Main'
function ensureExecutableForCloud(code) {
  if (!code) return code;
  let processed = code.replace(/^(\s*package\s+[^;]+;)/gm, '// $1');

  if (/\b(?:public\s+)?class\s+Main\b/.test(processed)) {
    if (!/\bpublic\s+class\s+Main\b/.test(processed)) {
      processed = processed.replace(/\bclass\s+Main\b/, 'public class Main');
    }
    return processed;
  }

  // If main class is named differently, rename it to Main for the cloud runner
  const mainClassMatch = processed.match(/(?:^|\s)(?:public\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\{[\s\S]*?public\s+static\s+void\s+main\s*\(/);
  if (mainClassMatch && mainClassMatch[1] !== 'Main') {
    const origName = mainClassMatch[1];
    return processed.replace(new RegExp('\\b(?:public\\s+)?class\\s+' + origName + '\\b'), 'public class Main');
  }

  return processed;
}

// Cloud compiler proxy for environments without a local JDK
async function runViaCloudProxy(code, stdin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const preparedCode = ensureExecutableForCloud(code);
    const response = await fetch(CLOUD_COMPILER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: preparedCode, stdin }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Cloud compiler HTTP ${response.status}`);
    }
    const data = await response.json();
    return {
      stdout: data.stdout || '',
      stderr: data.stderr || '',
      exitCode: data.exitCode ?? 0,
      backend: '☁️ Cloud OpenJDK 21'
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// GET /health endpoint
app.get('/health', async (req, res) => {
  await detectJdk();
  res.json({
    status: 'ok',
    localJdk: localJdkAvailable,
    jdk: localJdkVersion,
    cloudReady: true,
    backend: localJdkAvailable ? localJdkVersion : 'Cloud OpenJDK 21'
  });
});

// Maximum process output size before truncation (512 KB)
const MAX_OUTPUT_BYTES = 512 * 1024;

// Run command with input, timeout, output cap, and client disconnect support
function runProcess(cmd, args, input = '', cwd = '', timeoutMs = 30000, res = null) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

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

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (res && resCloseHandler) {
        res.removeListener('close', resCloseHandler);
      }
      resolve(result);
    };

    const resCloseHandler = () => {
      if (res && !res.writableEnded) {
        try { child.kill('SIGKILL'); } catch (_) {}
        finish({
          stdout,
          stderr: 'Execution cancelled by client',
          exitCode: -1
        });
      }
    };
    if (res) {
      res.on('close', resCloseHandler);
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({
        stdout,
        stderr: (stderr ? stderr + '\n' : '') + 'Execution timed out (30s limit)',
        exitCode: -1
      });
    }, timeoutMs);

    child.on('error', (err) => {
      finish({
        stdout: '',
        stderr: err.code === 'ENOENT'
          ? 'javac/java not found. Make sure JDK is installed and in PATH.'
          : String(err),
        exitCode: -1
      });
    });

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += data.toString('utf-8');
          if (stdout.length >= MAX_OUTPUT_BYTES) {
            stdout += '\n[Output truncated: 512KB limit exceeded]';
            try { child.kill('SIGKILL'); } catch (_) {}
          }
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += data.toString('utf-8');
          if (stderr.length >= MAX_OUTPUT_BYTES) {
            stderr += '\n[Error output truncated: 512KB limit exceeded]';
            try { child.kill('SIGKILL'); } catch (_) {}
          }
        }
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
      finish({
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

  // Prepare code: handles packages, raw statements/snippets, and class names
  const { code: preparedCode, className, wrapped, wrapperOffset } = prepareJavaCode(code);

  // If local JDK is not installed in the container environment, use cloud execution immediately
  if (!localJdkAvailable) {
    try {
      const cloudResult = await runViaCloudProxy(preparedCode, stdin);
      return res.json({
        ...cloudResult,
        className
      });
    } catch (err) {
      return res.status(502).json({
        stdout: '',
        stderr: 'Cloud compiler unavailable: ' + err.message,
        exitCode: -1
      });
    }
  }

  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javaforge-'));
    const javaFilePath = path.join(tmpDir, `${className}.java`);
    fs.writeFileSync(javaFilePath, preparedCode, 'utf-8');

    // 1. Compile with javac using UTF-8 encoding
    const compileResult = await runProcess('javac', ['-encoding', 'UTF-8', javaFilePath], '', tmpDir, 30000, res);
    if (compileResult.exitCode !== 0) {
      // If javac binary was missing despite detection, fall back to cloud
      if (compileResult.stderr && compileResult.stderr.includes('not found')) {
        localJdkAvailable = false;
        const cloudResult = await runViaCloudProxy(preparedCode, stdin);
        return res.json({ ...cloudResult, className });
      }

      let cleanedErr = cleanPaths(compileResult.stderr, tmpDir);
      if (wrapped && wrapperOffset > 0) {
        cleanedErr = cleanedErr.replace(new RegExp(`\\b${className}\\.java:(\\d+):`, 'g'), (_, line) => {
          const adj = Math.max(1, parseInt(line, 10) - wrapperOffset);
          return `${className}.java:${adj}:`;
        });
      }

      return res.json({
        stdout: '',
        stderr: cleanedErr,
        exitCode: compileResult.exitCode,
        backend: localJdkVersion,
        className
      });
    }

    // 2. Run with java using UTF-8 and memory limit
    const runResult = await runProcess(
      'java',
      ['-Dfile.encoding=UTF-8', '-Xmx256m', '-cp', tmpDir, className],
      stdin,
      tmpDir,
      30000,
      res
    );

    let cleanedErr = cleanPaths(runResult.stderr, tmpDir);
    if (wrapped && wrapperOffset > 0) {
      cleanedErr = cleanedErr.replace(new RegExp(`\\b${className}\\.java:(\\d+)\\b`, 'g'), (_, line) => {
        const adj = Math.max(1, parseInt(line, 10) - wrapperOffset);
        return `${className}.java:${adj}`;
      });
    }

    return res.json({
      stdout: runResult.stdout,
      stderr: cleanedErr,
      exitCode: runResult.exitCode,
      backend: localJdkVersion,
      className
    });
  } catch (err) {
    // Attempt cloud fallback on unexpected local failure
    try {
      const cloudResult = await runViaCloudProxy(preparedCode, stdin);
      return res.json({ ...cloudResult, className });
    } catch (cloudErr) {
      return res.json({
        stdout: '',
        stderr: String(err),
        exitCode: -1,
        className
      });
    }
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
