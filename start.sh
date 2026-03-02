#!/bin/bash
# Code-Lab サーバー起動スクリプト
# Claude Code環境変数を完全除去してからサーバーを起動
unset CLAUDECODE
unset CLAUDE_CODE
unset CLAUDE_CODE_ENTRYPOINT
unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
cd /Users/shigemotoyasunari/Code-Lab
node server.js
