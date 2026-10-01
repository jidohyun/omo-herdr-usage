# omo-herdr-usage

**AI subscription usage (Claude, Codex) in a Herdr side pane for OmO.** Like [omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag), it opens a pane next to your OmO session inside Herdr.

## 설치

[OmO](https://github.com/code-yeongyu/oh-my-openagent)와 [Herdr](https://herdr.dev/), [Bun](https://bun.sh) 1.4 이상, git이 필요합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jidohyun/omo-herdr-usage/main/install.sh | sh
```

- `~/.omo/agent/omo-herdr-usage`에 내려받고, omo 확장 `~/.omo/agent/extensions/omo-herdr-usage.js`를 등록합니다.
- herdr 안에서 새 omo 세션을 열거나 `/reload`하면 아래쪽에 `AI 사용량` pane이 뜹니다.
- **업데이트:** 같은 명령을 다시 실행합니다.
- **제거:** `curl -fsSL https://raw.githubusercontent.com/jidohyun/omo-herdr-usage/main/install.sh | sh -s -- --uninstall`
- 다른 agent 폴더를 쓰면 `OMO_CODING_AGENT_DIR`를 지정하세요. 특정 버전은 `OMO_HERDR_USAGE_REF=v0.1.0`처럼 고정할 수 있습니다.

## 소개

구독 중인 AI 서비스의 사용량 한도(%), 리셋까지 남은 시간, 페이스, 크레딧을 한 화면에 모아 보여주는 터미널 뷰어입니다.
Claude와 Codex는 각 CLI가 이미 저장해 둔 로그인 토큰으로 사용량 API를 직접 조회합니다(한 번에 1초 안쪽).

- Claude: 키체인의 `Claude Code-credentials` 토큰으로 `api.anthropic.com/api/oauth/usage` 조회
- Codex: `auth.json` 토큰으로 `chatgpt.com/backend-api/wham/usage` 조회
- **계정 출처:** 이 맥에 로그인된 Claude·Codex 계정을 아래 곳에서 모두 찾아 계정마다 따로 보여 줍니다. 어디서든 계정을 추가하면 다음 갱신 때 자동으로 나타납니다.
  - omo (`~/.omo/agent/auth.json`, 여러 계정)
  - Claude Code (키체인)
  - codex CLI (`~/.codex` 또는 `CODEX_HOME`)
  - CodexBar 관리 계정
  - OpenCode (`~/.local/share/opencode/auth.json`)
- 같은 이메일은 한 줄로 합치고, 유효한 토큰 중 가장 오래 가는 것을 씁니다. 줄 옆에 그 계정이 로그인된 곳이 모두 표시됩니다. 전부 만료된 계정은 어디서 다시 로그인하면 되는지 알려 줍니다.

두 API 모두 공개 문서가 없는 내부 API라 바뀔 수 있습니다. 토큰은 읽기만 하고 갱신하지 않습니다.

## 요구사항

- Bun 1.4 이상
- Claude Code 로그인 (토큰이 만료되면 Claude Code를 한 번 실행하면 갱신됨)
- Codex 로그인 (`~/.codex`) 또는 CodexBar 앱이 관리하는 Codex 계정

## herdr 없이 터미널에서 실행

```sh
git clone https://github.com/jidohyun/omo-herdr-usage.git && cd omo-herdr-usage
bun run start   # 라이브 대시보드
bun run once    # 한 번만 출력하고 종료
bun run build   # dist/aiusage 단일 바이너리 생성
```

## 옵션

| 옵션 | 설명 |
| --- | --- |
| `--once` | 한 번 출력하고 종료 |
| `--interval <초>` | 새로고침 주기, 기본값 60, 최소 15 |
| `--codexbar` | codexbar CLI로 Cursor 등 다른 프로바이더도 함께 표시 (호출당 약 12초) |
| `--fixture <path>` | 저장해 둔 codexbar JSON으로 렌더 |
| `--no-color` | 색상 끄기 |
| `--help` | 도움말 |

## 설정 파일

`~/.config/aiusage/config.json` (명령줄 옵션이 우선합니다)

```json
{ "sources": { "opencode": false }, "hide": ["old@example.com"], "codexbar": false }
```

`sources`로 출처를 끌 수 있습니다(`omo`, `claudeCode`, `codexCli`, `codexBar`, `opencode`, 기본은 모두 켜짐). `hide`에 이메일을 넣으면 그 계정은 숨깁니다.

## omo 확장 (herdr pane)

herdr 안에서 omo 세션을 시작하면 아래쪽에 `AI 사용량` pane이 자동으로 열립니다. 소스를 직접 받아 개발할 때는 저장소 폴더에서 `bun run omo:install` / `bun run omo:uninstall`로 그 폴더를 가리키는 확장을 등록·제거할 수 있습니다.

- herdr 탭 하나에 pane 하나만 엽니다. 같은 탭에서 omo 세션을 여러 개 열어도 이미 열린 pane을 씁니다.
- pane에서 `q`로 닫으면 그 탭에서는 다시 자동으로 열지 않습니다. omo에서 `/usage-pane`을 입력하면 다시 엽니다.
- 여러 pane이 떠 있어도 조회 결과를 `~/.cache/aiusage/snapshot.json` 하나에 저장해 같이 쓰므로, API 호출이 pane 수만큼 늘지 않습니다. Claude가 429를 주면 대기 시간도 모든 pane이 같이 지킵니다.
- herdr 밖의 omo, `omo -p` 같은 UI 없는 실행, 서브에이전트 세션에서는 아무것도 하지 않습니다.

### pane 옮기기 (사용량 pane을 클릭한 뒤 키 입력)

| 키 | 위치 |
| --- | --- |
| 방향키 하나 (`↑` `↓` `←` `→`) | 지금 자리에서 그 방향으로 한 칸 이동. `↑`/`↓`는 바로 위·아래 pane 하나를 건너 그 반대편으로, `←`/`→`는 옆 열로 옮기되 위에서 몇 번째인지 유지합니다(옆 열이 더 짧으면 맨 아래). 끝이면 "이미 위쪽 끝"처럼 알려 줍니다. 두 번째 키를 기다리느라 0.2초 뒤에 움직입니다 |
| 방향키 두 개를 0.2초 안에 연달아 (`↑→`, `→↑` 등 순서 무관) | 탭의 그 모서리. 모서리에 있는 pane을 위아래로 나눠 그 칸에 들어갑니다 |
| 숫자 `8` `2` `4` `6` | omo 에이전트 pane의 위·아래·왼쪽·오른쪽에 바로 배치 |
| 숫자 `7` `9` `1` `3` | 탭의 좌측상단·우측상단·좌측하단·우측하단에 바로 배치 |

예) 한 열에 omo / 셸 / 사용량이 쌓여 있으면 `↑` 한 번에 셸 위로, 한 번 더에 omo 위(맨 위)로 갑니다. 가운데 열 2번째에서 `←`를 누르면 왼쪽 열 2번째로 갑니다.

herdr는 같은 탭 안에서 pane을 바로 옮기지 못해서, 잠깐 임시 탭으로 뺐다가 원하는 자리에 다시 넣습니다(임시 탭은 저절로 닫힘). 탭 전체 폭/높이를 차지하는 띠 모양 배치는 herdr가 지원하지 않습니다.

설정 파일의 `pane` 항목으로 바꿀 수 있습니다:

```json
{ "pane": { "autoOpen": true, "direction": "down", "ratio": 0.75 } }
```

`ratio`는 원래 pane이 차지할 비율입니다(0.75면 사용량 pane이 아래 25%). `autoOpen: false`면 `/usage-pane`으로만 엽니다.

## 키

- `q` 또는 `Ctrl-C`: 종료
- `r`: 즉시 새로고침

## 개발

```sh
bun install
bun test
bun run typecheck
```

## 라이선스

MIT
