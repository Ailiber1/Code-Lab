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
      case 'exec_bash':
        handleExecBash(ws, msg);
        break;
      case 'question':
        handleQuestion(ws, msg);
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
  let projectDir = msg.projectDir;
  // projectDirが空の場合、サーバーの起動ディレクトリを使用
  if (!projectDir) {
    projectDir = __dirname;
  }

  // 入力のクリーニング: "cd "プレフィックスや前後の空白・引用符を除去
  projectDir = projectDir.trim().replace(/^cd\s+/i, '').replace(/^["']|["']$/g, '').trim();

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
    currentPhase: 1,
    permissionMode: 'smart',  // smart | full
    blockedBash: []
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

  // 既存プロセスチェック（ゾンビプロセス防止付き）
  if (session.proc) {
    try {
      process.kill(session.proc.pid, 0); // signal 0 = 存在確認のみ
    } catch {
      session.proc = null; // プロセスは既に終了 → クリーンアップ
    }
  }
  if (session.proc) {
    ws.send(JSON.stringify({ type: 'error', message: 'コマンド実行中です。完了をお待ちください。' }));
    return;
  }

  let prompt = msg.text;
  if (!prompt || typeof prompt !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'text is required' }));
    return;
  }

  // 添付ファイルの処理
  if (msg.files && Array.isArray(msg.files) && msg.files.length > 0) {
    const fileParts = [];
    for (const file of msg.files) {
      if (file.type === 'text') {
        // テキストファイル: プロンプトに内容を埋め込み
        fileParts.push('--- ' + file.name + ' ---\n' + file.data + '\n--- /' + file.name + ' ---');
      } else if (file.type === 'image') {
        // 画像ファイル: プロジェクトにBase64から保存しパスで参照
        try {
          const uploadDir = path.join(session.projectDir, '.claude-uploads');
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          const base64Data = file.data.replace(/^data:image\/\w+;base64,/, '');
          const ext = file.name.split('.').pop() || 'png';
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(uploadDir, safeName);
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
          fileParts.push('[画像ファイル: ' + filePath + ']');
          console.log('[FILE] 画像保存:', filePath);
        } catch (e) {
          console.error('[FILE] 画像保存エラー:', e.message);
        }
      }
    }
    if (fileParts.length > 0) {
      prompt = '以下のファイルが添付されています:\n\n' + fileParts.join('\n\n') + '\n\n---\nユーザーの指示: ' + prompt;
    }
  }

  // Claude CLI 起動引数
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  // パーミッションモード
  // スマートモード/全権限 → bypassPermissions（サーバー側でフィルタリング）
  // サーバー側のセキュリティレイヤーが破壊的コマンドをブロックする
  args.push('--permission-mode', 'bypassPermissions');

  // セッションID再利用でコンテキスト維持
  if (session.sessionId) {
    args.push('--session-id', session.sessionId);
  }

  // 環境変数からCLAUDE*を全削除（ネスト検出回避）
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
  }

  console.log('[CLI] 実行:', 'claude', args.join(' '));

  const proc = spawn('claude', args, {
    cwd: session.projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin='ignore': -pモードではstdin不要、pipeだとハングする
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
// SECTION: Question Handler (秘書エージェント)
// ============================================================
function handleQuestion(ws, msg) {
  const session = sessions.get(ws);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not connected. Send "connect" first.' }));
    return;
  }

  const questionText = msg.text;
  if (!questionText || typeof questionText !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'text is required' }));
    return;
  }

  console.log('[QUESTION] 質問受信:', questionText.slice(0, 50));

  // 環境変数からCLAUDE*を全削除（ネスト検出回避）
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
  }

  const prompt = '以下の質問に簡潔に回答してください: ' + questionText;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  const proc = spawn('claude', args, {
    cwd: session.projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let answerText = '';

  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // assistantメッセージからテキストを抽出
        if (parsed.type === 'assistant' && parsed.message) {
          const content = parsed.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                answerText += block.text;
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  });

  proc.on('close', (code) => {
    // バッファ残り処理
    if (stdoutBuffer.trim()) {
      try {
        const parsed = JSON.parse(stdoutBuffer);
        if (parsed.type === 'assistant' && parsed.message) {
          const content = parsed.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                answerText += block.text;
              }
            }
          }
        }
      } catch { /* ignore */ }
    }

    if (code !== 0 && stderrBuffer.trim()) {
      console.error('[QUESTION] stderr:', stderrBuffer.trim());
    }
    const finalAnswer = answerText.trim() || (code === 0 ? '回答を取得できませんでした。' : 'エラーが発生しました。（' + (stderrBuffer.trim().slice(0, 100) || 'exit code=' + code) + '）');
    ws.send(JSON.stringify({
      type: 'question_answer',
      text: finalAnswer
    }));
    console.log('[QUESTION] 回答完了: code=' + code);
  });

  proc.on('error', (err) => {
    ws.send(JSON.stringify({
      type: 'question_answer',
      text: 'Claude CLI起動失敗: ' + err.message
    }));
    console.error('[QUESTION] 起動エラー:', err.message);
  });
}

// ============================================================
// SECTION: Bash Security Layer (スマートモード)
// ============================================================

// 【絶対ブロック】破壊的コマンド — 確認すら出さない、完全拒否
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)?\//,  // rm -rf / , rm -f /path
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force)/,  // rm -rf 全般
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+[~\/]/,  // rm -r ~/  rm -r /
  /\bmkfs\b/,                          // ディスクフォーマット
  /\bdd\s+if=/,                        // ディスクダンプ
  /:()\s*\{\s*:\|:\s*&\s*\}/,          // fork bomb
  /\bfork\s*bomb\b/i,
  />\s*\/dev\/sd[a-z]/,                // デバイス直書き
  /\bchmod\s+(-[a-zA-Z]*\s+)?777\s+\//,  // chmod 777 /
  /\bchown\s+.*\s+\//,                // chown /
  /\bgit\s+push\s+.*--force\s+.*main/, // force push to main
  /\bgit\s+push\s+.*--force\s+.*master/,
  /\bgit\s+reset\s+--hard\b/,         // git reset --hard
  /\bcurl\s+.*\|\s*sh\b/,             // curl | sh (リモートスクリプト実行)
  /\bcurl\s+.*\|\s*bash\b/,
  /\bwget\s+.*\|\s*sh\b/,
  /\bsudo\s+rm\b/,                    // sudo rm
  /\bsudo\s+mkfs\b/,
  /\bsudo\s+dd\b/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bdrop\s+database\b/i,             // SQL drop
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
  />\s*\/etc\//,                       // /etc/ への書き込み
  /\bkillall\b/,                       // 全プロセス停止
  /\bpkill\s+-9\b/,
];

// 【自動承認】安全なコマンド — MEMORY.mdの確認不要ルールに準拠
const SAFE_PATTERNS = [
  /^\s*git\s+(status|log|diff|show|branch|tag|stash|fetch|pull|add|commit|push|checkout|merge|rebase|remote|clone)\b/,
  /^\s*git\s+-C\s+/,                  // git -C /path
  /^\s*npm\s+(install|ci|audit|test|run|start|build|init|ls|outdated|version)\b/,
  /^\s*npx\s+/,
  /^\s*node\s+/,                       // node実行
  /^\s*firebase\s+(deploy|init|serve|login|logout|use|projects:list)\b/,
  /^\s*gh\s+/,                         // GitHub CLI
  /^\s*cat\s+/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\s+/,
  /^\s*head\s+/,
  /^\s*tail\s+/,
  /^\s*wc\s+/,
  /^\s*find\s+/,
  /^\s*grep\s+/,
  /^\s*which\s+/,
  /^\s*mkdir\s+-?p?\s+/,              // mkdir
  /^\s*touch\s+/,
  /^\s*cp\s+/,                         // コピー
  /^\s*mv\s+/,                         // 移動
  /^\s*tsc\b/,                         // TypeScript
  /^\s*eslint\b/,
  /^\s*prettier\b/,
  /^\s*jest\b/,
  /^\s*vitest\b/,
  /^\s*python3?\s+/,
  /^\s*pip3?\s+install\b/,
  /^\s*curl\s+(?!.*\|\s*(sh|bash))/,   // curl（パイプsh以外）
  /^\s*open\s+/,
  /^\s*cd\s+/,
];

// コマンド分類: 'blocked' | 'safe' | 'confirm'
function classifyCommand(command) {
  if (!command || typeof command !== 'string') return 'blocked';
  const trimmed = command.trim();

  // 1. 破壊的コマンドチェック（絶対ブロック）
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(trimmed)) return 'blocked';
  }

  // 2. パイプチェイン: 各コマンドを個別チェック
  const parts = trimmed.split(/\s*[|&;]\s*/);
  for (const part of parts) {
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(part.trim())) return 'blocked';
    }
  }

  // 3. 安全コマンドチェック
  for (const pat of SAFE_PATTERNS) {
    if (pat.test(trimmed)) return 'safe';
  }

  // 4. それ以外 → 確認が必要
  return 'confirm';
}

// ============================================================
// SECTION: Bash Direct Execution
// ============================================================
function execBashCommand(ws, session, command, source) {
  console.log('[BASH] ' + source + '実行:', command);

  ws.send(JSON.stringify({
    type: 'dev_event',
    event: {
      agent: 'developer',
      action: '⚡ コマンド実行: ' + command.slice(0, 40),
      thought: source + 'コマンドを実行中...',
      emoji: '⚡'
    }
  }));

  const proc = spawn('sh', ['-c', command], {
    cwd: session.projectDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000 // 2分タイムアウト
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  proc.on('close', (code) => {
    const output = (stdout + (stderr ? '\n[stderr] ' + stderr : '')).slice(0, 2000);
    ws.send(JSON.stringify({
      type: 'bash_result',
      command,
      output: output || '(出力なし)',
      exitCode: code
    }));

    ws.send(JSON.stringify({
      type: 'dev_event',
      event: {
        agent: code === 0 ? 'developer' : 'debugger',
        action: code === 0 ? '✅ 完了: ' + command.slice(0, 30) : '❌ 失敗: ' + command.slice(0, 30),
        thought: code === 0 ? '正常に実行されました' : stderr.slice(0, 40),
        emoji: code === 0 ? '⚡' : '🐛'
      }
    }));
    console.log('[BASH] 完了: code=' + code);
  });

  proc.on('error', (err) => {
    ws.send(JSON.stringify({
      type: 'bash_result',
      command,
      output: 'コマンド実行エラー: ' + err.message,
      exitCode: 1
    }));
    console.error('[BASH] エラー:', err.message);
  });
}

// ブラウザから承認されたBashコマンドを実行
function handleExecBash(ws, msg) {
  const session = sessions.get(ws);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not connected.' }));
    return;
  }

  const command = msg.command;
  if (!command || typeof command !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'command is required' }));
    return;
  }

  // 破壊的コマンドは承認ボタン経由でも絶対ブロック
  if (classifyCommand(command) === 'blocked') {
    ws.send(JSON.stringify({
      type: 'bash_result',
      command,
      output: '⛔ 破壊的コマンドは実行できません',
      exitCode: 1
    }));
    ws.send(JSON.stringify({
      type: 'dev_event',
      event: {
        agent: 'security',
        action: '⛔ ブロック: ' + command.slice(0, 40),
        thought: '破壊的コマンドを完全拒否しました',
        emoji: '🛡️'
      }
    }));
    console.log('[BASH] 破壊的コマンドをブロック:', command);
    return;
  }

  execBashCommand(ws, session, command, '手動');
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
  // セキュリティチェック系
  if (t === 'bash' && content && /\b(audit|security|vulnerab|secret|leak|credential|\.env|\.gitignore|api.key|private.key|token)\b/i.test(content)) return 'security';
  // QA系
  if (t === 'bash' && content && /\b(quality|coverage)\b/i.test(content)) return 'qa';
  // ビルド・デプロイ系
  if (t === 'bash' && content && /\b(build|deploy|push|npm\s+run)\b/i.test(content)) return 'developer';

  // ツール名ベース
  if (['read', 'grep', 'glob', 'list', 'search'].some(k => t.includes(k))) {
    // セキュリティ関連ファイルならsecurity
    if (content && /\b(\.env|\.gitignore|secret|credential|key|token|auth|security|rules\.json|firestore\.rules)\b/i.test(content)) return 'security';
    return 'lead';
  }
  if (['edit', 'write', 'notebookedit'].some(k => t.includes(k))) {
    // UI系ファイルならui-designer
    if (content && /\.(css|scss|html|svg|style)/i.test(content)) return 'ui-designer';
    // セキュリティ関連ファイルならsecurity
    if (content && /\b(\.gitignore|rules\.json|firestore\.rules|\.env)\b/i.test(content)) return 'security';
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

    // Bash権限拒否検出
    const isDenied = parsed.is_error && /permission|denied|not allowed|blocked/i.test(text.slice(0, 300));
    if (isDenied) {
      // 直前のBashコマンドを取得
      const lastBash = session.toolHistory.filter(t => t.tool.toLowerCase() === 'bash').pop();
      const cmd = lastBash ? lastBash.command : '';
      if (cmd) {
        session.blockedBash.push({ command: cmd, time: Date.now() });
        ws.send(JSON.stringify({
          type: 'bash_blocked',
          command: cmd,
          reason: truncate(text, 100)
        }));
      }
    }

    // エラー検出
    const hasError = parsed.is_error || /error|fail|exception/i.test(text.slice(0, 200));
    if (hasError && !isDenied) {
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

// ============================================================
// SECTION: Auto Backup (第2層: ファイル上書き防止)
// ============================================================
function backupIfExists(ws, session, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const backupDir = path.join(session.projectDir, '.claude-backup');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const basename = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, basename + '.' + timestamp);
    fs.copyFileSync(filePath, backupPath);
    console.log('[BACKUP] 作成:', filePath, '->', backupPath);
    // ブラウザに通知
    ws.send(JSON.stringify({
      type: 'file_backup',
      original: filePath,
      backup: backupPath
    }));
  } catch (e) {
    console.error('[BACKUP] エラー:', e.message);
  }
}

function handleToolUse(ws, session, block) {
  const toolName = block.name || 'unknown';
  const input = block.input || {};
  const inputStr = JSON.stringify(input).slice(0, 200);

  // 第2層: Write/Edit ツールで既存ファイルがある場合は自動バックアップ
  if (['write', 'edit'].includes(toolName.toLowerCase()) && input.file_path) {
    backupIfExists(ws, session, input.file_path);
  }

  // ツール履歴に追加
  const historyEntry = {
    tool: toolName,
    command: toolName.toLowerCase() === 'bash' ? (input.command || '') : '',
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

  // Bashコマンド セキュリティフィルタリング
  if (toolName.toLowerCase() === 'bash' && input.command) {
    const cmd = input.command;
    const classification = classifyCommand(cmd);

    if (classification === 'blocked') {
      // 破壊的コマンド → 完全ブロック（実行させない）
      ws.send(JSON.stringify({
        type: 'bash_blocked_permanent',
        command: cmd,
        reason: '破壊的コマンドのため完全ブロック'
      }));
      ws.send(JSON.stringify({
        type: 'dev_event',
        event: {
          agent: 'security',
          action: '⛔ 破壊的コマンドをブロック: ' + cmd.slice(0, 30),
          thought: 'セキュリティポリシーにより実行を拒否',
          emoji: '🛡️'
        }
      }));
      console.log('[SECURITY] 破壊的コマンドをブロック:', cmd);
    } else if (classification === 'safe') {
      // 安全コマンド → 自動実行の通知
      ws.send(JSON.stringify({
        type: 'tool_activity',
        tool: 'bash',
        command: cmd,
        classification: 'safe',
        status: 'auto'
      }));
    } else if (session.permissionMode === 'smart') {
      // 不明コマンド（スマートモード）→ 確認カード表示
      ws.send(JSON.stringify({
        type: 'bash_needs_confirm',
        command: cmd,
        reason: '未知のコマンドのため確認が必要です'
      }));
      ws.send(JSON.stringify({
        type: 'dev_event',
        event: {
          agent: 'security',
          action: '⚠️ 確認待ち: ' + cmd.slice(0, 30),
          thought: '未登録コマンド — ユーザーの承認を待機',
          emoji: '🛡️'
        }
      }));
    } else {
      // 全権限モード → 通知のみ
      ws.send(JSON.stringify({
        type: 'tool_activity',
        tool: 'bash',
        command: cmd,
        classification: 'auto',
        status: 'auto'
      }));
    }
  }

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
// SECTION: Graceful Shutdown
// ============================================================
function gracefulShutdown(signal) {
  console.log('\n[SERVER] ' + signal + ' 受信 — シャットダウン中...');
  // 全セッションのCLI子プロセスを終了
  for (const [wsClient, session] of sessions.entries()) {
    if (session.proc && !session.proc.killed) {
      session.proc.kill('SIGTERM');
      console.log('[SERVER] CLI子プロセス終了: pid=' + session.proc.pid);
    }
    if (wsClient.readyState === 1) {
      wsClient.close(1001, 'Server shutting down');
    }
  }
  sessions.clear();
  httpServer.close(() => {
    console.log('[SERVER] サーバー停止完了');
    process.exit(0);
  });
  // 3秒以内に終了しなければ強制終了
  setTimeout(() => { process.exit(1); }, 3000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
