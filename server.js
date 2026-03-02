// ============================================================
// Code-Lab Phase 2: WebSocket Bridge Server
// Claude Code CLI ↔ ブラウザ の橋渡し
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = 3456;
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'];

// ============================================================
// SECTION: HTTP Static Server
// ============================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function servePath(reqPath) {
  // パストラバーサル防止
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  return path.join(__dirname, safePath === '/' ? 'index.html' : safePath);
}

const httpServer = http.createServer((req, res) => {
  const filePath = servePath(req.url);

  // __dirname 外へのアクセスを拒否
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============================================================
// SECTION: WebSocket Server
// ============================================================
const wss = new WebSocketServer({ server: httpServer });

// アクティブなCLIプロセス管理
const sessions = new Map(); // ws -> { proc, sessionId, projectDir, toolHistory }

wss.on('connection', (ws, req) => {
  // localhost のみ許可
  const remoteAddr = req.socket.remoteAddress;
  if (!ALLOWED_HOSTS.some(h => remoteAddr === h || remoteAddr === '::ffff:' + h)) {
    ws.close(4003, 'Forbidden: localhost only');
    return;
  }

  console.log('[WS] クライアント接続:', remoteAddr);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'connect':
        handleConnect(ws, msg);
        break;
      case 'command':
        handleCommand(ws, msg);
        break;
      case 'abort':
        handleAbort(ws);
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type: ' + msg.type }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] クライアント切断');
    handleAbort(ws);
    sessions.delete(ws);
  });
});

// ============================================================
// SECTION: Connection Handler
// ============================================================
function handleConnect(ws, msg) {
  const projectDir = msg.projectDir;
  if (!projectDir) {
    ws.send(JSON.stringify({ type: 'error', message: 'projectDir is required' }));
    return;
  }

  // パストラバーサル防止: 正規化して存在チェック
  const resolvedDir = path.resolve(projectDir);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid directory: ' + projectDir }));
    return;
  }

  sessions.set(ws, {
    proc: null,
    sessionId: null,
    projectDir: resolvedDir,
    toolHistory: [],
    currentPhase: 1
  });

  ws.send(JSON.stringify({
    type: 'connected',
    projectDir: resolvedDir,
    message: 'プロジェクトに接続しました: ' + resolvedDir
  }));
  console.log('[CLI] プロジェクト接続:', resolvedDir);
}

// ============================================================
// SECTION: Command Execution
// ============================================================
function handleCommand(ws, msg) {
  const session = sessions.get(ws);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not connected. Send "connect" first.' }));
    return;
  }

  // 既存プロセスがあれば終了
  if (session.proc) {
    ws.send(JSON.stringify({ type: 'error', message: 'A command is already running. Send "abort" first.' }));
    return;
  }

  const prompt = msg.text;
  if (!prompt || typeof prompt !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'text is required' }));
    return;
  }

  // Claude CLI 起動引数
  const args = ['-p', prompt, '--output-format', 'stream-json'];

  // acceptEdits モード
  args.push('--permission-mode', 'acceptEdits');

  // セッションID再利用でコンテキスト維持
  if (session.sessionId) {
    args.push('--session-id', session.sessionId);
  }

  // 環境変数からCLAUDECODE削除（ネスト検出回避）
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;

  console.log('[CLI] 実行:', 'claude', args.join(' '));

  const proc = spawn('claude', args, {
    cwd: session.projectDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false // シェルインジェクション回避
  });

  session.proc = proc;
  session.toolHistory = [];

  // 開始通知
  ws.send(JSON.stringify({
    type: 'dev_event',
    event: {
      agent: 'lead',
      action: '指示を受け付けました: ' + prompt.slice(0, 50),
      thought: '分析中...',
      emoji: '📋'
    }
  }));

  // stdout: stream-json の行単位パース
  let stdoutBuffer = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    // 最後の不完全な行はバッファに戻す
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        processStreamJson(ws, session, parsed);
      } catch {
        // JSON でない行は無視
      }
    }
  });

  // stderr: エラー出力
  let stderrBuffer = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  proc.on('close', (code) => {
    // バッファ残り処理
    if (stdoutBuffer.trim()) {
      try {
        const parsed = JSON.parse(stdoutBuffer);
        processStreamJson(ws, session, parsed);
      } catch { /* ignore */ }
    }

    session.proc = null;

    // 完了通知
    ws.send(JSON.stringify({
      type: 'dev_event',
      event: {
        agent: 'lead',
        action: code === 0 ? '処理完了' : 'エラーで終了 (code: ' + code + ')',
        thought: code === 0 ? '全タスク完了!' : stderrBuffer.slice(0, 100),
        emoji: code === 0 ? '✅' : '❌',
        stat: code === 0 ? 'files' : 'bugs',
        statDelta: code === 0 ? 0 : 1
      }
    }));

    ws.send(JSON.stringify({
      type: 'command_done',
      exitCode: code,
      error: stderrBuffer.slice(0, 500) || null
    }));

    console.log('[CLI] 終了: code=' + code);
  });

  proc.on('error', (err) => {
    session.proc = null;
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Claude CLI起動失敗: ' + err.message + '\nclaude コマンドがPATHにあるか確認してください'
    }));
    console.error('[CLI] 起動エラー:', err.message);
  });
}

// ============================================================
// SECTION: Abort Handler
// ============================================================
function handleAbort(ws) {
  const session = sessions.get(ws);
  if (!session || !session.proc) return;

  console.log('[CLI] プロセス中断');
  session.proc.kill('SIGTERM');
  setTimeout(() => {
    if (session.proc) {
      session.proc.kill('SIGKILL');
      session.proc = null;
    }
  }, 3000);
}

// ============================================================
// SECTION: stream-json Parser → DevEvent Converter
// ============================================================

// エージェントマッピング: ツール名 → 担当エージェント
function detectAgent(toolName, content) {
  if (!toolName) return 'lead';
  const t = toolName.toLowerCase();

  // テスト系
  if (t === 'bash' && content && /\b(test|jest|vitest|mocha|pytest|npm\s+test)\b/i.test(content)) return 'tester';
  // リント・レビュー系
  if (t === 'bash' && content && /\b(lint|eslint|prettier|format)\b/i.test(content)) return 'reviewer';
  // セキュリティ・QA系
  if (t === 'bash' && content && /\b(audit|security|vulnerab)\b/i.test(content)) return 'qa';
  // ビルド・デプロイ系
  if (t === 'bash' && content && /\b(build|deploy|push|npm\s+run)\b/i.test(content)) return 'developer';

  // ツール名ベース
  if (['read', 'grep', 'glob', 'list', 'search'].some(k => t.includes(k))) return 'lead';
  if (['edit', 'write', 'notebookedit'].some(k => t.includes(k))) {
    // UI系ファイルならui-designer
    if (content && /\.(css|scss|html|svg|style)/i.test(content)) return 'ui-designer';
    return 'developer';
  }
  if (t === 'bash') return 'developer';

  return 'lead';
}

// Phase自動推定: ツール履歴から現在のPhaseを推定
function estimatePhase(toolHistory) {
  if (toolHistory.length === 0) return 1;

  const recent = toolHistory.slice(-10);
  const tools = recent.map(t => t.tool.toLowerCase());

  // 分析系ツールが多い → Phase 1 (設計)
  const readCount = tools.filter(t => ['read', 'grep', 'glob'].some(k => t.includes(k))).length;
  const editCount = tools.filter(t => ['edit', 'write'].some(k => t.includes(k))).length;
  const bashCount = tools.filter(t => t === 'bash').length;
  const testCount = recent.filter(t => t.isTest).length;

  if (editCount === 0 && bashCount === 0 && readCount > 0) return 1; // 設計（読み取りのみ）
  if (editCount > 0 && testCount === 0) return 2; // 実装
  if (testCount > 0 && recent.some(t => t.hasError)) return 4; // バグ修正
  if (testCount > 0) return 3; // レビュー/テスト
  if (bashCount > 0 && recent.some(t => t.isDeploy)) return 6; // デプロイ

  return 2; // デフォルト: 実装
}

function processStreamJson(ws, session, parsed) {
  // stream-json フォーマットに応じて処理
  // 参考: https://docs.anthropic.com/en/docs/claude-code/cli-usage

  const type = parsed.type;

  // セッションID取得
  if (parsed.session_id && !session.sessionId) {
    session.sessionId = parsed.session_id;
    console.log('[CLI] セッションID取得:', session.sessionId);
  }

  // --- assistant メッセージ（テキスト出力）---
  if (type === 'assistant' && parsed.message) {
    const content = parsed.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const agent = detectAgent(null, block.text);
          ws.send(JSON.stringify({
            type: 'dev_event',
            event: {
              agent,
              action: truncate(block.text, 60),
              thought: extractThought(block.text),
              emoji: '💬'
            }
          }));
        }
        if (block.type === 'tool_use') {
          handleToolUse(ws, session, block);
        }
      }
    }
  }

  // --- tool_use（ツール呼び出し）---
  if (type === 'tool_use' || (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use')) {
    const block = parsed.content_block || parsed;
    handleToolUse(ws, session, block);
  }

  // --- tool_result（ツール実行結果）---
  if (type === 'tool_result' || type === 'result') {
    const content = parsed.content || parsed.result || '';
    const text = typeof content === 'string' ? content :
                 Array.isArray(content) ? content.map(b => b.text || '').join(' ') : '';

    // エラー検出
    const hasError = parsed.is_error || /error|fail|exception/i.test(text.slice(0, 200));
    if (hasError) {
      ws.send(JSON.stringify({
        type: 'dev_event',
        event: {
          agent: 'debugger',
          action: 'エラー検出: ' + truncate(text, 50),
          thought: 'エラーを分析中...',
          emoji: '🐛',
          stat: 'bugs',
          statDelta: 1
        }
      }));
    }
  }

  // --- system メッセージ ---
  if (type === 'system' && parsed.message) {
    ws.send(JSON.stringify({
      type: 'dev_event',
      event: {
        agent: 'lead',
        action: 'システム: ' + truncate(String(parsed.message), 60),
        emoji: '⚙️'
      }
    }));
  }
}

function handleToolUse(ws, session, block) {
  const toolName = block.name || 'unknown';
  const input = block.input || {};
  const inputStr = JSON.stringify(input).slice(0, 200);

  // ツール履歴に追加
  const historyEntry = {
    tool: toolName,
    isTest: /\b(test|jest|vitest|mocha|pytest)\b/i.test(inputStr),
    hasError: false,
    isDeploy: /\b(deploy|push|publish)\b/i.test(inputStr),
    time: Date.now()
  };
  session.toolHistory.push(historyEntry);

  // エージェント判定
  const agent = detectAgent(toolName, inputStr);

  // アクション文生成
  const action = formatToolAction(toolName, input);

  // stat更新
  let stat = null, statDelta = 0;
  if (['edit', 'write', 'notebookedit'].some(k => toolName.toLowerCase().includes(k))) {
    stat = 'lines';
    statDelta = estimateLinesDelta(toolName, input);
  }
  if (['read', 'glob', 'grep'].some(k => toolName.toLowerCase().includes(k))) {
    stat = 'files';
    statDelta = 1;
  }

  // Phase推定
  const newPhase = estimatePhase(session.toolHistory);
  let phaseUpdate = null;
  if (newPhase !== session.currentPhase) {
    session.currentPhase = newPhase;
    phaseUpdate = newPhase;
  }

  const event = {
    agent,
    action,
    thought: formatToolThought(toolName, input),
    emoji: toolEmoji(toolName)
  };
  if (stat) { event.stat = stat; event.statDelta = statDelta; }
  if (phaseUpdate) event.phase = phaseUpdate;

  ws.send(JSON.stringify({ type: 'dev_event', event }));
}

// ============================================================
// SECTION: Utility Functions
// ============================================================
function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function extractThought(text) {
  // 最初の1文を思考として抽出
  if (!text) return '';
  const first = text.split(/[。\n]/)[0];
  return truncate(first, 40);
}

function formatToolAction(toolName, input) {
  const t = toolName.toLowerCase();
  if (t === 'read') return '📖 ファイル読み取り: ' + shortPath(input.file_path);
  if (t === 'edit') return '✏️ ファイル編集: ' + shortPath(input.file_path);
  if (t === 'write') return '📝 ファイル作成: ' + shortPath(input.file_path);
  if (t === 'glob') return '🔎 ファイル検索: ' + (input.pattern || '');
  if (t === 'grep') return '🔍 コード検索: ' + truncate(input.pattern, 30);
  if (t === 'bash') return '⚡ コマンド実行: ' + truncate(input.command, 40);
  if (t === 'notebookedit') return '📓 ノートブック編集';
  return '🔧 ' + toolName;
}

function formatToolThought(toolName, input) {
  const t = toolName.toLowerCase();
  if (t === 'read') return shortPath(input.file_path) + ' を確認中...';
  if (t === 'edit') return shortPath(input.file_path) + ' を修正中...';
  if (t === 'write') return '新規ファイルを作成中...';
  if (t === 'bash') return 'コマンドを実行中...';
  if (t === 'grep') return 'パターンを検索中...';
  if (t === 'glob') return 'ファイルを探索中...';
  return toolName + ' を実行中...';
}

function toolEmoji(toolName) {
  const map = {
    read: '📖', edit: '✏️', write: '📝', bash: '⚡',
    grep: '🔍', glob: '🔎', notebookedit: '📓',
    agent: '🤖', webfetch: '🌐', websearch: '🌐'
  };
  return map[toolName.toLowerCase()] || '🔧';
}

function shortPath(filePath) {
  if (!filePath) return '';
  const parts = filePath.split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : filePath;
}

function estimateLinesDelta(toolName, input) {
  const t = toolName.toLowerCase();
  if (t === 'write' && input.content) {
    return input.content.split('\n').length;
  }
  if (t === 'edit' && input.new_string) {
    const newLines = input.new_string.split('\n').length;
    const oldLines = input.old_string ? input.old_string.split('\n').length : 0;
    return Math.max(0, newLines - oldLines);
  }
  return 5; // デフォルト推定
}

// ============================================================
// SECTION: Start Server
// ============================================================
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║  🧪 Code-Lab サーバー起動               ║');
  console.log('  ║  URL: http://localhost:' + PORT + '              ║');
  console.log('  ║  WebSocket: ws://localhost:' + PORT + '          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  ブラウザで http://localhost:' + PORT + ' を開いてください');
  console.log('  Ctrl+C で終了');
  console.log('');
});
